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
   * prediction, as is any full-context pass (the one that reports the errors). Call once after the parser's
   * construction: the simulator exists only then.
   */
  settleStatements(): void {
    const simulator = this.interpreter;
    const alts = simpleStmtAlts(this.atn, this.ruleNames);
    const stream = this.inputStream as CommonTokenStream;
    let filled = false;
    const predict = simulator.adaptivePredict.bind(simulator);
    simulator.adaptivePredict = (input: TokenStream, decision: number, outer: ParserRuleContext | null): number => {
      if (decision === alts.decision && simulator.predictionMode === PredictionMode.SLL) {
        if (!filled) {
          stream.fill();
          filled = true;
        }
        const alt = this.simpleStatementForm(stream, alts);
        if (alt > 0) return alt;
      }
      return predict(input, decision, outer);
    };
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
