/*
 * The parser predicates of grammars-v4's Rust grammar (rust/Antlr4ng/RustParserBase.ts, MIT licence — see
 * grammars/antlr/rust/RustParser.g4): `>>` and `<<` lexed as one token are split back into two when a generic
 * closes. They read tokens only.
 */
import { ParserRuleContext, PredictionMode, RuleTransition, AtomTransition, PrecedencePredicateTransition, StarLoopEntryState, type ATN, type TokenStream, Parser } from "antlr4ng";
import { RustLexer } from "./RustLexer.js";

/** The decisions `settleExpressions` answers, found in the ATN by shape so a grammar change cannot misnumber them. */
interface SettledDecisions {
  /** `if … { } (else …)?`: the optional `else`. */
  elseDecisions: Set<number>;
  /** An expression rule's operator choice, with the method-call alternative and the precedence it needs. */
  methodCall: Map<number, { alt: number; precedence: number }>;
  /** The precedence the method-call alternative needs, by the loop-entry decision of its rule. */
  loopPrecedence: Map<number, number>;
}

const EXPRESSION_RULES = ["expression", "statementExpression"];

/** The first token-matching transitions reachable from `from` through epsilon steps (predicates included), with the rule each following one enters. */
function leadingAtoms(from: { transitions: readonly { isEpsilon: boolean; target: any }[] }): { token: number; next: number }[] {
  const out: { token: number; next: number }[] = [];
  const seen = new Set<number>();
  const queue = [...from.transitions.map((t) => t.target)];
  while (queue.length > 0) {
    const state = queue.pop()!;
    if (seen.has(state.stateNumber)) continue;
    seen.add(state.stateNumber);
    for (const t of state.transitions) {
      if (t instanceof AtomTransition) {
        const after = t.target.transitions[0];
        out.push({ token: t.label.minElement, next: after instanceof RuleTransition ? after.ruleIndex : -1 });
      } else if (t.isEpsilon && !(t instanceof RuleTransition)) queue.push(t.target);
    }
  }
  return out;
}

/** The precedence a left-recursive alternative's predicate asks (`precpred(ctx, n)`), or -1. */
function precedenceOf(from: { transitions: readonly { isEpsilon: boolean; target: any }[] }): number {
  const seen = new Set<number>();
  const queue = [...from.transitions.map((t) => t.target)];
  while (queue.length > 0) {
    const state = queue.pop()!;
    if (seen.has(state.stateNumber)) continue;
    seen.add(state.stateNumber);
    for (const t of state.transitions) {
      if (t instanceof PrecedencePredicateTransition) return t.precedence;
      if (t.isEpsilon && !(t instanceof RuleTransition)) queue.push(t.target);
    }
  }
  return -1;
}

/** Per grammar, not per file: the ATN is shared by every parser of the grammar and scanning it for every macro argument's parse cost 13 % of a Rust run. */
const SETTLED = new WeakMap<ATN, SettledDecisions>();

function settledDecisions(atn: ATN, ruleNames: readonly string[]): SettledDecisions {
  let found = SETTLED.get(atn);
  if (!found) SETTLED.set(atn, (found = scanDecisions(atn, ruleNames)));
  return found;
}

function scanDecisions(atn: ATN, ruleNames: readonly string[]): SettledDecisions {
  const ifRule = ruleNames.indexOf("ifExpression");
  const segment = ruleNames.indexOf("pathExprSegment");
  const exprRules = new Set(EXPRESSION_RULES.map((n) => ruleNames.indexOf(n)));
  const result: SettledDecisions = { elseDecisions: new Set(), methodCall: new Map(), loopPrecedence: new Map() };
  const loops = new Map<number, number>();
  atn.decisionToState.forEach((state, decision) => {
    if (state.ruleIndex === ifRule && state.transitions.length === 2) {
      const first = leadingAtoms({ transitions: [state.transitions[0]!] });
      if (first.length === 1 && first[0]!.token === RustLexer.KW_ELSE) result.elseDecisions.add(decision);
    }
    if (!exprRules.has(state.ruleIndex)) return;
    if (state instanceof StarLoopEntryState && state.precedenceRuleDecision) loops.set(decision, state.ruleIndex);
    // The operator choice: the one alternative that starts `. segment` (a method call, `x.f(y)`).
    const calls = state.transitions
      .map((t, i) => ({ i, atoms: leadingAtoms({ transitions: [t] }) }))
      .filter(({ atoms }) => atoms.some((a) => a.token === RustLexer.DOT && a.next === segment));
    if (state.transitions.length > 2 && calls.length === 1) {
      const precedence = precedenceOf({ transitions: [state.transitions[calls[0]!.i]!] });
      if (precedence >= 0) result.methodCall.set(decision, { alt: calls[0]!.i + 1, precedence });
    }
  });
  for (const [decision, rule] of loops) {
    const same = [...result.methodCall].filter(([d]) => atn.decisionToState[d]!.ruleIndex === rule);
    if (same.length === 1) result.loopPrecedence.set(decision, same[0]![1].precedence);
  }
  return result;
}

export abstract class RustParserBase extends Parser {
  constructor(input: TokenStream) {
    super(input);
  }

  protected NextGT(): boolean {
    return this.inputStream.LA(1) === RustLexer.GT;
  }

  /**
   * Answers two families of decisions from tokens in an SLL pass, as prediction would: the optional `else` of an
   * `if` (an `else` goes on with the `if`, anything else ends it) and the method call `x.f(` in an expression's
   * operator loop (`. name (` is a method call; a call of a field `(x.f)(y)` reads the same tokens, and the
   * lower alternative wins). Prediction told those apart by reading the whole else-branch or argument list, which
   * built a state per distinct token sequence: a third of one large codebase's prediction states each. Full-context
   * passes, which report the errors, are untouched. Call once after the parser's construction.
   */
  settleExpressions(): void {
    const simulator = this.interpreter;
    const settled = settledDecisions(this.atn, this.ruleNames);
    const predict = simulator.adaptivePredict.bind(simulator);
    simulator.adaptivePredict = (input: TokenStream, decision: number, outer: ParserRuleContext | null): number => {
      if (simulator.predictionMode === PredictionMode.SLL) {
        if (settled.elseDecisions.has(decision)) return input.LA(1) === RustLexer.KW_ELSE ? 1 : 2;
        const method = settled.methodCall.get(decision);
        const precedence = method?.precedence ?? settled.loopPrecedence.get(decision);
        if (precedence !== undefined && input.LA(1) === RustLexer.DOT && input.LA(3) === RustLexer.LPAREN && (input.LA(2) === RustLexer.NON_KEYWORD_IDENTIFIER || input.LA(2) === RustLexer.RAW_IDENTIFIER) && this.precpred(outer ?? this.context, precedence)) {
          return method?.alt ?? 1;
        }
      }
      return predict(input, decision, outer);
    };
  }

  protected NextLT(): boolean {
    return this.inputStream.LA(1) === RustLexer.LT;
  }
}
