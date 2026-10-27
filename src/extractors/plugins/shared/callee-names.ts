/**
 * Names for a call a tree-sitter front end found, from its callee read as steps left to right, spelled as the
 * brace languages' regex call scan spells them (a path is its last two names) and, where the scan names nothing,
 * as the linker can type it: a method on a call's result is the chain from its first call, one on a construction
 * the type's. Each reader turns its grammar's callee into these steps; the naming is shared.
 */
import type { PatternCallName } from "./antlr-calls.js";
import type { CallPattern } from "./regex-base.js";

export type CalleeStep =
  | { kind: "id"; name: string; line: number; column: number }
  /** A call's arguments; `constructs` when the call builds a value of a capitalized type (`Club(id: 1)`). */
  | { kind: "call"; constructs?: string }
  /** A receiver no name spells: `bare` when the scan still reads the method alone (`"s".trim(`), else none. */
  | { kind: "other"; bare: boolean };

type IdStep = Extract<CalleeStep, { kind: "id" }>;

const named = (name: string, leafName: string, at: IdStep, receiverType?: string): PatternCallName => ({
  name,
  leafName,
  line: at.line,
  column: at.column,
  ...(receiverType ? { receiverType } : {}),
});

/** The steps of a call's own callee: a single capitalized name builds that type. */
export function callStep(callee: readonly CalleeStep[]): CalleeStep {
  const only = callee.length === 1 ? callee[0]! : null;
  return only?.kind === "id" && /^[A-Z]/.test(only.name) ? { kind: "call", constructs: only.name } : { kind: "call" };
}

/**
 * The chain a call's result is named by — `repo.find()`, `repo.find().first()`, `Club.load()` for a method on a
 * construction — as the names before each `()`, or null when a step has no name.
 */
function chainOf(steps: readonly CalleeStep[], depth: number): { parts: string[]; head: IdStep } | null {
  const last = steps.at(-1);
  if (last?.kind !== "call") return null;
  const callee = steps.slice(0, -1);
  const name = callee.at(-1);
  if (name?.kind !== "id") return null;
  const prev = callee.at(-2);
  if (!prev) return { parts: [name.name], head: name };
  if (prev.kind === "id") {
    const before = callee.at(-3)?.kind;
    return before === "call" || before === "other" ? null : { parts: [`${prev.name}.${name.name}`], head: prev };
  }
  if (prev.kind !== "call") return null;
  const receiver = callee.slice(0, -1);
  if (prev.constructs && receiver.length === 2) return { parts: [`${prev.constructs}.${name.name}`], head: receiver[0] as IdStep };
  const inner = chainOf(receiver, depth);
  return inner && inner.parts.length < depth ? { parts: [...inner.parts, name.name], head: inner.head } : null;
}

/** The name of a call whose callee is `steps`, or null when it names none. */
export function nameCall(steps: readonly CalleeStep[], chainDepth: number): PatternCallName | null {
  const leaf = steps.at(-1);
  if (leaf?.kind !== "id") return null;
  const prev = steps.at(-2);
  if (!prev) return named(leaf.name, leaf.name, leaf);
  if (prev.kind === "id") return named(`${prev.name}.${leaf.name}`, leaf.name, prev);
  if (prev.kind === "other") return prev.bare ? named(leaf.name, leaf.name, leaf) : null;
  const receiver = steps.slice(0, -1);
  if (prev.constructs && receiver.length === 2) return named(`${prev.constructs}.${leaf.name}`, leaf.name, receiver[0] as IdStep, prev.constructs);
  const chain = chainOf(receiver, chainDepth);
  return chain ? named(`${chain.parts.map((p) => `${p}()`).join(".")}.${leaf.name}`, leaf.name, chain.head) : null;
}

/**
 * The name a language's call pattern gives the call whose source runs `source` (its callee's text and the `(`
 * that opens its arguments) — a container lookup, a field path — when a pattern's match ends exactly there; null
 * when the pattern names no call, undefined when none matches.
 */
export function patternNamedCall(source: string, patterns: readonly CallPattern[], line: number, column: number): PatternCallName | null | undefined {
  for (const pattern of patterns) {
    for (const m of source.matchAll(new RegExp(pattern.pattern.source, pattern.pattern.flags.replace("g", "") + "g"))) {
      if (m.index + m[0].length !== source.length) continue;
      const built = pattern.buildName(m, source);
      if (!built.name) return null;
      return {
        name: built.name,
        leafName: built.leafName,
        line,
        column,
        ...(built.receiverType ? { receiverType: built.receiverType } : {}),
        ...(built.receiverQualifier ? { receiverQualifier: built.receiverQualifier } : {}),
      };
    }
  }
  return undefined;
}
