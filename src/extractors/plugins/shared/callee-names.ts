/**
 * Names for a call a tree-sitter front end found, from its callee read as steps left to right, spelled as the
 * brace languages' regex call scan spells them (a path is its last two names, or every name with `paths`) and,
 * where the scan names nothing, as the linker can type it: a method on a call's result is the chain from its first
 * call, one on a construction the type's. Each reader turns its grammar's callee into these steps; the naming is shared.
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

const named = (name: string, leafName: string, at: IdStep, receiverType?: string, receiverCut?: boolean): PatternCallName => ({
  name,
  leafName,
  line: at.line,
  column: at.column,
  ...(receiverType ? { receiverType } : {}),
  ...(receiverCut ? { receiverCut: true as const } : {}),
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

export interface NameCallOptions {
  /**
   * Name a call through a path by every name back to its head (`club.league.relegate`,
   * `PlayerService.instance.addPlayer`), not its last two, so the linker types the receiver from the head: read
   * as `league.relegate`, the call is typed by whatever `league` is in the caller (its own field of another type).
   */
  paths?: boolean;
}

/** The name of a call whose callee is `steps`, or null when it names none. */
export function nameCall(steps: readonly CalleeStep[], chainDepth: number, options?: NameCallOptions): PatternCallName | null {
  if (options?.paths) return namePathCall(steps, chainDepth);
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

/** Heads naming the caller's own instance: `self.repo.find(` stays `repo.find`, as every scan names it. */
const OWN_HEADS: ReadonlySet<string> = new Set(["self", "this", "super", "Self"]);

/**
 * `nameCall` with `paths`: the receiver spelled from its head — names joined by dots, a call's result as its
 * callee's name and `()` (`repo.find().league.relegate`, `club.league.table().first`). A receiver no name spells
 * (`items[0].league.relegate(`, a construction's field) keeps the name before the method alone, as before, and
 * says so (`receiverCut`): `league` there is no name the caller binds.
 */
function namePathCall(steps: readonly CalleeStep[], depth: number): PatternCallName | null {
  const leaf = steps.at(-1);
  if (leaf?.kind !== "id") return null;
  const prev = steps.at(-2);
  if (!prev) return named(leaf.name, leaf.name, leaf);
  if (prev.kind === "other") return prev.bare ? named(leaf.name, leaf.name, leaf) : null;
  const receiver = steps.slice(0, -1);
  if (prev.kind === "call" && prev.constructs && receiver.length === 2) {
    return named(`${prev.constructs}.${leaf.name}`, leaf.name, receiver[0] as IdStep, prev.constructs);
  }
  const spelled = receiverPath(receiver, depth, 0);
  if (spelled) return named(`${spelled.text}.${leaf.name}`, leaf.name, spelled.head);
  return prev.kind === "id" ? named(`${prev.name}.${leaf.name}`, leaf.name, prev, undefined, steps.length > 2) : null;
}

/**
 * Receiver steps as text, or null when a step names nothing (or the chain is deeper than `depth` calls). A
 * qualifier before a capitalized name — a package or an import prefix (`java.util.UUID`, `ui.Color`) — is left
 * off, as the scans leave it, and so is `self.`/`this.` before a single name.
 */
function receiverPath(steps: readonly CalleeStep[], depth: number, calls: number): { text: string; head: IdStep; calls: number } | null {
  const last = steps.at(-1);
  if (!last || last.kind === "other") return null;
  if (last.kind === "call") {
    // A call's result: its callee's name, then `()`. A construction is a receiver only directly (`Club(1).save`).
    if (last.constructs || calls + 1 > depth) return null;
    const callee = steps.slice(0, -1);
    if (callee.at(-1)?.kind !== "id") return null;
    const inner = receiverPath(callee, depth, calls + 1);
    return inner ? { text: `${inner.text}()`, head: inner.head, calls: inner.calls } : null;
  }
  let k = steps.length - 1;
  while (k > 0 && steps[k - 1]!.kind === "id") k--;
  let ids = steps.slice(k) as IdStep[];
  if (k === 0) {
    for (let j = ids.length - 1; j > 0; j--) {
      if (/^[A-Z]/.test(ids[j]!.name) && /^[a-z_]/.test(ids[j - 1]!.name) && !OWN_HEADS.has(ids[j - 1]!.name)) {
        ids = ids.slice(j);
        break;
      }
    }
    if (ids.length === 2 && OWN_HEADS.has(ids[0]!.name)) ids = ids.slice(1);
    return { text: ids.map((s) => s.name).join("."), head: ids[0]!, calls };
  }
  const before = steps[k - 1]!;
  if (before.kind !== "call") return null;
  // A member of a construction is the type's (`Club(1).players()` is `Club.players`).
  if (before.constructs) return k === 2 ? { text: `${before.constructs}.${ids.map((s) => s.name).join(".")}`, head: steps[0] as IdStep, calls } : null;
  const inner = receiverPath(steps.slice(0, k), depth, calls);
  return inner ? { text: `${inner.text}.${ids.map((s) => s.name).join(".")}`, head: inner.head, calls: inner.calls } : null;
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
