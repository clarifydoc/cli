/*
 * The semantic predicates of grammars-v4's Go grammar (golang/TypeScript/GoParserBase.ts, BSD licence — see
 * grammars/antlr/go/GoParser.g4), ported from the `antlr4` runtime to antlr4ng. Token types are read from the
 * lexer rather than the parser, so this module does not import the parser that extends it.
 *
 * Every predicate reads tokens only. Upstream's also read a table of the file's import names, and a
 * prediction the shared DFA cached for one file then misread the next (the same file parsed with or without
 * errors depending on what was parsed before it).
 */
import { ParserRuleContext, PredictionMode, RuleTransition, type ATN, type ATNState, type CommonTokenStream, Parser, type TokenStream } from "antlr4ng";
import { GoLexer } from "./GoLexer.js";

/** Tokens that can only start a type: after `(`, a conversion's parenthesized type. */
const TYPE_OPENERS: ReadonlySet<number> = new Set([GoLexer.L_BRACKET, GoLexer.MAP, GoLexer.CHAN, GoLexer.STRUCT, GoLexer.INTERFACE]);

/** The simplest statement forms by the first token, at bracket depth 0, that says which form it is. */
interface SimpleStmtAlts {
  decision: number;
  incDec: number;
  assignment: number;
  expression: number;
  shortVarDecl: number;
}

/** The alternative of `decision` whose start reaches `rule` before a token (which alternative a sub-rule is). */
function altReaching(atn: ATN, decision: number, rule: number): number {
  const state = atn.decisionToState[decision]!;
  for (let i = 0; i < state.transitions.length; i++) {
    const seen = new Set<number>();
    const queue: ATNState[] = [state.transitions[i]!.target];
    while (queue.length > 0) {
      const s = queue.pop()!;
      if (seen.has(s.stateNumber)) continue;
      seen.add(s.stateNumber);
      for (const t of s.transitions) {
        if (t instanceof RuleTransition) {
          if (t.ruleIndex === rule) return i + 1;
        } else if (t.isEpsilon) queue.push(t.target);
      }
    }
  }
  return 0;
}

/** `simpleStmt`'s decision and its alternatives, found in the ATN by the rule each starts, so a grammar change cannot misnumber them. */
function simpleStmtAlts(atn: ATN, ruleNames: readonly string[]): SimpleStmtAlts {
  const rule = (name: string) => {
    const index = ruleNames.indexOf(name);
    if (index < 0) throw new Error(`Go grammar: no rule ${name}`);
    return index;
  };
  const simple = rule("simpleStmt");
  const decision = atn.decisionToState.findIndex((s) => s.ruleIndex === simple && s.transitions.length > 1);
  const alts = {
    decision,
    incDec: altReaching(atn, decision, rule("incDecStmt")),
    assignment: altReaching(atn, decision, rule("assignment")),
    expression: altReaching(atn, decision, rule("expressionStmt")),
    shortVarDecl: altReaching(atn, decision, rule("shortVarDecl")),
  };
  if (decision < 0 || Object.values(alts).some((a) => a <= 0)) throw new Error("Go grammar: no simple-statement decision");
  return alts;
}

/** The operand decision and the primary expression's operand-or-conversion decision, with what each alternative may start with. */
interface OperandDecisions {
  /** `operand`: a literal, a name, a parenthesized expression. */
  operand: number;
  literal: number;
  name: number;
  /** `primaryExpr`'s first choice: an operand or a conversion. */
  primary: number;
  primaryOperand: number;
  /** Per decision, the alternative a first token alone settles (a token no other alternative starts with). */
  only: Map<number, Map<number, number>>;
  /** Rules a `{` right after a name cannot be a block inside: a bracketed list, a statement (see `bracedLiteralHere`). */
  literalOnly: ReadonlySet<number>;
  /** Rules whose header a `{` after a name may open the block of (`if ok {`, `for x := range items {`). */
  blockOpeners: ReadonlySet<number>;
  /** `keyedElement`'s choice between `key COLON element` and `element`, and the alternative that has the key. */
  keyed: number;
  keyedWithKey: number;
}

/** The decisions of `operand` and `primaryExpr`'s head, found in the ATN by the rules they reach. */
function operandDecisions(atn: ATN, ruleNames: readonly string[]): OperandDecisions {
  const rule = (name: string) => {
    const index = ruleNames.indexOf(name);
    if (index < 0) throw new Error(`Go grammar: no rule ${name}`);
    return index;
  };
  const operandRule = rule("operand");
  const primaryRule = rule("primaryExpr");
  const operand = atn.decisionToState.findIndex((s) => s.ruleIndex === operandRule && s.transitions.length === 3);
  const primary = atn.decisionToState.findIndex((s, d) => s.ruleIndex === primaryRule && s.transitions.length === 2 && altReaching(atn, d, operandRule) > 0);
  if (operand < 0 || primary < 0) throw new Error("Go grammar: no operand decision");
  const ruleSet = (names: string[]) => new Set(names.map(rule));
  const keyedRule = rule("keyedElement");
  const keyed = atn.decisionToState.findIndex((st, d) => st.ruleIndex === keyedRule && st.transitions.length === 2 && altReaching(atn, d, rule("key")) > 0);
  if (keyed < 0) throw new Error("Go grammar: no keyed-element decision");
  const decisions: OperandDecisions = {
    keyed,
    keyedWithKey: altReaching(atn, keyed, rule("key")),
    literalOnly: ruleSet(["arguments", "index", "slice_", "typeArgs", "literalValue", "keyedElement", "key", "element", "statement", "declaration", "sourceFile", "operand"]),
    blockOpeners: ruleSet(["ifStmt", "forStmt", "exprSwitchStmt", "typeSwitchStmt", "typeSwitchGuard", "selectStmt"]),
    operand,
    literal: altReaching(atn, operand, rule("literal")),
    name: altReaching(atn, operand, rule("operandName")),
    primary,
    primaryOperand: altReaching(atn, primary, operandRule),
    only: new Map(),
  };
  if (decisions.literal <= 0 || decisions.name <= 0 || decisions.primaryOperand <= 0) throw new Error("Go grammar: no operand alternatives");
  for (const decision of [operand, primary]) {
    const state = atn.decisionToState[decision]!;
    const firsts = state.transitions.map((t) => atn.nextTokens(t.target));
    const only = new Map<number, number>();
    for (let alt = 0; alt < firsts.length; alt++) {
      for (let type = 1; type <= atn.maxTokenType; type++) {
        if (firsts[alt]!.contains(type) && firsts.every((set, other) => other === alt || !set.contains(type))) only.set(type, alt + 1);
      }
    }
    decisions.only.set(decision, only);
  }
  return decisions;
}

/** The decisions settled from tokens, found once per grammar: the ATN is the grammar's own, shared by every parser of it. */
const DECISIONS = new WeakMap<ATN, { alts: SimpleStmtAlts; operands: OperandDecisions }>();

function settledDecisions(atn: ATN, ruleNames: readonly string[]): { alts: SimpleStmtAlts; operands: OperandDecisions } {
  let found = DECISIONS.get(atn);
  if (!found) DECISIONS.set(atn, (found = { alts: simpleStmtAlts(atn, ruleNames), operands: operandDecisions(atn, ruleNames) }));
  return found;
}

export abstract class GoParserBase extends Parser {
  constructor(input: TokenStream) {
    super(input);
  }

  protected isNotReceive(): boolean {
    return this.inputStream.LT(2)?.type !== GoLexer.RECEIVE;
  }

  /** Anything but a parenthesized type (`([]*T)(nil)`, `(map[K]V)(m)`), which opens a conversion. */
  protected isOperand(): boolean {
    return !(this.inputStream.LA(1) === GoLexer.L_PAREN && TYPE_OPENERS.has(this.inputStream.LA(2)));
  }

  /** A conversion's type opens with a type literal (`[]byte(s)`); `T(x)` reads as a call. */
  protected isConversion(): boolean {
    return this.inputStream.LA(1) !== GoLexer.IDENTIFIER;
  }

  /**
   * Settles the simple statement's decision from tokens in an SLL pass. Which of its five forms a statement is
   * (`a, b := f(x)`, `m[k] = v`, `n++`, `f(x)`, a send) is told by the first token after its leading expression
   * list, and prediction read the whole expression to find it: two thirds of one large codebase's prediction
   * states, and most of its prediction time, were this decision's. The scan skips bracketed groups, and stops
   * at the token that says which form it is (`:=`, `=`, `++`/`--`) or at the statement's end (an expression
   * statement); a `{` or a `<-` outside brackets is not told from a block or a unary receive, and is left to
   * prediction, as is any full-context pass (the one that reports the errors). Like `GoReadLexer`, which retypes the
   * `(` after a `make`/`new` callee, it keeps Go's simple-statement decision cheap. Call once after the parser's
   * construction: the simulator exists only then.
   */
  settleStatements(): void {
    const simulator = this.interpreter;
    const { alts, operands } = settledDecisions(this.atn, this.ruleNames);
    const stream = this.inputStream as CommonTokenStream;
    let filled = false;
    const predict = simulator.adaptivePredict.bind(simulator);
    simulator.adaptivePredict = (input: TokenStream, decision: number, outer: ParserRuleContext | null): number => {
      if (simulator.predictionMode === PredictionMode.SLL) {
        if (decision === alts.decision) {
          if (!filled) {
            stream.fill();
            filled = true;
          }
          const alt = this.simpleStatementForm(stream, alts);
          if (alt > 0) return alt;
        } else if ((decision === operands.operand || decision === operands.primary) && !(decision === operands.operand ? process.env.NOOPD : process.env.NOPRIM)) {
          const alt = this.operandForm(stream, decision, operands, outer);
          if (alt > 0) return alt;
        } else if (decision === operands.keyed && !process.env.NOKEY) {
          if (!filled) {
            stream.fill();
            filled = true;
          }
          const alt = this.keyedForm(stream, operands);
          if (alt > 0) return alt;
        }
      }
      return predict(input, decision, outer);
    };
  }

  /**
   * The alternative of an operand decision the next tokens say, or 0 where prediction must read on. A token only one
   * alternative starts with settles it. A name settles `primaryExpr` (a conversion's type cannot start with one: its
   * predicate refuses it) and, for `operand`, whenever it cannot open a composite literal: no `{` right after it, after
   * `pkg.Name` or after a bracketed type-argument list (`Box[Club]{}`). A `{` there is a literal wherever no block can
   * follow the expression (`bracedLiteralHere`), and else a literal or a block (`if ok {`), which prediction tells by
   * what follows. A `[]T{` against `[]T(`, `[]Club{` or `map[K]V(` leading `primaryExpr` is a literal or a conversion by the token that ends
   * its type.
   */
  private operandForm(stream: CommonTokenStream, decision: number, operands: OperandDecisions, outer: ParserRuleContext | null): number {
    const first = stream.LA(1);
    if (first === GoLexer.IDENTIFIER) {
      if (decision === operands.primary) return operands.primaryOperand;
      let i = 2;
      let next = stream.LA(i);
      if (next === GoLexer.DOT) {
        if (stream.LA(3) !== GoLexer.IDENTIFIER) return operands.name;
        i = 4;
        next = stream.LA(i);
      }
      if (next === GoLexer.L_BRACKET) {
        const close = this.closingBracket(stream, i);
        if (close < 0) return 0;
        i = close + 1;
        next = stream.LA(i);
      }
      if (next !== GoLexer.L_CURLY) return operands.name;
      return this.bracedLiteralHere(outer, operands) ? operands.literal : operands.name;
    }
    if (decision === operands.primary && (first === GoLexer.L_BRACKET || first === GoLexer.MAP)) return this.typeLiteralForm(stream, operands);
    return operands.only.get(decision)?.get(first) ?? 0;
  }

  /** The index of the `]` closing the `[` at lookahead position `i`, or -1. */
  private closingBracket(stream: CommonTokenStream, i: number): number {
    let depth = 0;
    for (; ; i++) {
      const type = stream.LA(i);
      if (type === GoLexer.EOF) return -1;
      if (type === GoLexer.L_BRACKET) depth++;
      else if (type === GoLexer.R_BRACKET && --depth === 0) return i;
    }
  }

  /**
   * Whether the `{` after a name, an operand `outer` is parsing, opens a composite literal, or the block of an `if`,
   * `for` or `switch` whose header the operand ends: the Go spec's own rule, a literal of a bare type name there must
   * be parenthesized, so the first of a header (`if ok {`, `for _, c := range cases {`) and a bracketed list, a
   * statement or another literal (`f(Club{})`, `x := Club{}`) that an ancestor rule names decides.
   */
  private bracedLiteralHere(outer: ParserRuleContext | null, operands: OperandDecisions): boolean {
    for (let ctx = outer?.parent as ParserRuleContext | null | undefined; ctx; ctx = ctx.parent as ParserRuleContext | null) {
      if (operands.blockOpeners.has(ctx.ruleIndex)) return false;
      if (operands.literalOnly.has(ctx.ruleIndex)) return true;
    }
    return true;
  }

  /**
   * `[]Club{…}` (a composite literal) or `[]byte(s)` (a conversion), told by the first `{` or `(` after the type: a
   * slice, array or map type of names, pointers, bracketed lengths or keys and struct or interface bodies. A function or
   * channel type in it is left to prediction.
   */
  private typeLiteralForm(stream: CommonTokenStream, operands: OperandDecisions): number {
    for (let i = 1; ; i++) {
      switch (stream.LA(i)) {
        case GoLexer.L_BRACKET: {
          const close = this.closingBracket(stream, i);
          if (close < 0) return 0;
          i = close;
          break;
        }
        case GoLexer.MAP:
        case GoLexer.STAR:
        case GoLexer.IDENTIFIER:
        case GoLexer.DOT:
          break;
        case GoLexer.STRUCT:
        case GoLexer.INTERFACE: {
          // The type's own body, `struct{ … }` or `interface{ … }`, is skipped whole.
          if (stream.LA(i + 1) !== GoLexer.L_CURLY) return 0;
          let depth = 0;
          for (i++; ; i++) {
            const type = stream.LA(i);
            if (type === GoLexer.EOF) return 0;
            if (type === GoLexer.L_CURLY) depth++;
            else if (type === GoLexer.R_CURLY && --depth === 0) break;
          }
          break;
        }
        case GoLexer.L_CURLY:
          return operands.primaryOperand;
        case GoLexer.L_PAREN:
          return operands.primaryOperand === 1 ? 2 : 1;
        default:
          return 0;
      }
    }
  }

  /**
   * Whether a literal element has a key (`Name: value`): a `:` outside brackets before the element's end, a `,` or the
   * literal's `}` outside them.
   */
  private keyedForm(stream: CommonTokenStream, operands: OperandDecisions): number {
    let depth = 0;
    const withoutKey = operands.keyedWithKey === 1 ? 2 : 1;
    for (let i = stream.index; ; i++) {
      const token = stream.get(i);
      if (token.channel !== 0) continue;
      switch (token.type) {
        case GoLexer.L_PAREN:
        case GoLexer.MakeParen:
        case GoLexer.NewParen:
        case GoLexer.L_BRACKET:
        case GoLexer.L_CURLY:
          depth++;
          break;
        case GoLexer.R_PAREN:
        case GoLexer.R_BRACKET:
        case GoLexer.R_CURLY:
          if (--depth < 0) return withoutKey;
          break;
        case GoLexer.COMMA:
          if (depth === 0) return withoutKey;
          break;
        case GoLexer.COLON:
          if (depth === 0) return operands.keyedWithKey;
          break;
        case GoLexer.EOF:
          return 0;
      }
    }
  }

  /** The alternative the tokens from the stream's position say, or 0 where they do not. */
  private simpleStatementForm(stream: CommonTokenStream, alts: SimpleStmtAlts): number {
    let depth = 0;
    let first = true;
    for (let i = stream.index; ; i++) {
      const token = stream.get(i);
      if (token.channel !== 0) continue;
      const type = token.type;
      switch (type) {
        case GoLexer.L_PAREN:
        case GoLexer.MakeParen:
        case GoLexer.NewParen:
        case GoLexer.L_BRACKET:
          depth++;
          break;
        case GoLexer.R_PAREN:
        case GoLexer.R_BRACKET:
          if (--depth < 0) return alts.expression;
          break;
        case GoLexer.L_CURLY:
          if (depth === 0) return 0;
          depth++;
          break;
        case GoLexer.R_CURLY:
          if (--depth < 0) return alts.expression;
          break;
        case GoLexer.RECEIVE:
          if (depth === 0 && !first) return 0;
          break;
        case GoLexer.SEMI:
        case GoLexer.EOS:
        case GoLexer.EOF:
          if (depth === 0) return alts.expression;
          break;
        case GoLexer.DECLARE_ASSIGN:
          if (depth === 0) return alts.shortVarDecl;
          break;
        case GoLexer.ASSIGN:
          if (depth === 0) return alts.assignment;
          break;
        case GoLexer.PLUS_PLUS:
        case GoLexer.MINUS_MINUS:
          if (depth === 0) return alts.incDec;
          break;
      }
      if (type === GoLexer.EOF) return 0;
      first = false;
    }
  }
}
