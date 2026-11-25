/*
 * The decisions of the C grammar a parse settles from tokens (CParserBase.settle*), found in the ATN by the rules
 * their alternatives start, so a grammar change cannot misnumber them. Prediction there simulates every way an
 * expression, a declaration and a macro can begin, which on a cold start is most of the parse's prediction time.
 */
import { RuleTransition, type ATN, type ATNState } from "antlr4ng";

/** The alternative of `decision` whose start reaches `rule` before a token: which alternative a sub-rule is. */
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

/** A decision's alternatives by name, and the alternative each keyword or symbol token alone starts. */
export interface ChoiceAlts {
  decision: number;
  alts: Record<string, number>;
  /** Per token type, the one alternative that can start with it (a token two alternatives start with is absent). */
  only: ReadonlyMap<number, number>;
}

/** The decision of `rule` whose alternatives reach every one of `named`, with the tokens one alternative alone starts. */
function choiceOf(atn: ATN, ruleNames: readonly string[], rule: string, named: Record<string, string>): ChoiceAlts {
  const index = (name: string) => {
    const i = ruleNames.indexOf(name);
    if (i < 0) throw new Error(`C grammar: no rule ${name}`);
    return i;
  };
  const ruleIndex = index(rule);
  for (let d = 0; d < atn.decisionToState.length; d++) {
    const state = atn.decisionToState[d]!;
    if (state.ruleIndex !== ruleIndex) continue;
    const alts: Record<string, number> = {};
    for (const [label, name] of Object.entries(named)) alts[label] = altReaching(atn, d, index(name));
    const found = Object.values(alts);
    if (found.some((a) => a <= 0) || new Set(found).size !== found.length) continue;
    const firsts = state.transitions.map((t) => atn.nextTokens(t.target));
    const only = new Map<number, number>();
    for (let alt = 0; alt < firsts.length; alt++) {
      for (let type = 1; type <= atn.maxTokenType; type++) {
        if (firsts[alt]!.contains(type) && firsts.every((set, other) => other === alt || !set.contains(type))) only.set(type, alt + 1);
      }
    }
    return { decision: d, alts, only };
  }
  throw new Error(`C grammar: no decision of ${rule} reaching ${Object.values(named).join(", ")}`);
}

/** An optional or repeated part's decision: the alternative that enters `enter` and the one that leaves. */
export interface EnterOrLeave {
  decision: number;
  enter: number;
  leave: number;
}

/** The two-way decision of `rule` whose one alternative reaches rule `enter` before a token. */
function enterOrLeave(atn: ATN, ruleNames: readonly string[], rule: string, enter: string): EnterOrLeave {
  const ruleIndex = ruleNames.indexOf(rule);
  const enterIndex = ruleNames.indexOf(enter);
  if (ruleIndex < 0 || enterIndex < 0) throw new Error(`C grammar: no rule ${rule} or ${enter}`);
  for (let d = 0; d < atn.decisionToState.length; d++) {
    const state = atn.decisionToState[d]!;
    if (state.ruleIndex !== ruleIndex || state.transitions.length !== 2) continue;
    const alt = altReaching(atn, d, enterIndex);
    if (alt > 0) return { decision: d, enter: alt, leave: 3 - alt };
  }
  throw new Error(`C grammar: no decision of ${rule} entering ${enter}`);
}

export interface CDecisions {
  /** `declarationSpecifier+`'s loop and `Identifier ':' statement?`'s option. */
  specifiers: EnterOrLeave;
  afterLabel: EnterOrLeave;
  blockItem: ChoiceAlts;
  statement: ChoiceAlts;
  externalDeclaration: ChoiceAlts;
}

const FOUND = new WeakMap<ATN, CDecisions>();

/** The settled decisions of the grammar `atn` belongs to, found once: the ATN is shared by every parser of it. */
export function decisionsOf(atn: ATN, ruleNames: readonly string[]): CDecisions {
  let found = FOUND.get(atn);
  if (!found) {
    found = {
      specifiers: enterOrLeave(atn, ruleNames, "declarationSpecifiers", "declarationSpecifier"),
      afterLabel: enterOrLeave(atn, ruleNames, "labeledStatement", "statement"),
      blockItem: choiceOf(atn, ruleNames, "blockItem", { macro: "macroStatement", statement: "statement", declaration: "declaration" }),
      statement: choiceOf(atn, ruleNames, "statement", { label: "labeledStatement", macro: "macroStatement", macroBlock: "macroBlockStatement", expression: "expressionStatement" }),
      externalDeclaration: choiceOf(atn, ruleNames, "externalDeclaration", { macroFunction: "macroFunctionDefinition", topLevelMacro: "topLevelMacro", bareMacro: "bareMacro", functionDefinition: "functionDefinition", declaration: "declaration" }),
    };
    FOUND.set(atn, found);
  }
  return found;
}
