/**
 * Call names for a parser front end (ANTLR or tree-sitter), spelled as the regex call scan spells them (regex-base.ts
 * `extractCallsFromBody` and `callChainPatterns`), so a parsed call reaches the linker under the name the
 * pattern reading would have given it. The parser decides WHAT is a call; this decides only its name.
 */

import type { CallInfo } from "../../../types/analysis.js";
import { callRecorder } from "./regex-base.js";

/** One step of a callee expression, left to right. */
export type CalleeSegment =
  /** A name: the head identifier, or a member after `.`; `colon` for Lua's `obj:method`. */
  | { kind: "id"; name: string; line: number; column: number; colon?: boolean }
  /** A call's argument list. */
  | { kind: "call" }
  /** Anything a pattern cannot name: an index, a parenthesized or literal receiver, a type assertion. */
  | { kind: "other" };

export interface PatternCallName {
  name: string;
  leafName: string;
  line: number;
  column: number;
  /** The type a path names the call on (`Club::new` → `Club`), as a language's call pattern states it. */
  receiverType?: string;
  /** The registration a container lookup names (`Container.shared.repo()` → `repo`), as a call pattern states it. */
  receiverQualifier?: string;
}

/**
 * The name the regex scan gives a call whose callee is `segments`, or null when it names none:
 * - a selector path is its last two names — `s.repo.Find(` is `repo.Find`, as the baseline pattern reads it;
 * - a member called on a call's result is the chain from a head of one or two names, at most `chainDepth`
 *   calls deep — `pb.NewClient(conn).Get(` is `pb.NewClient().Get` (0 when the language has no chain patterns);
 * - a Lua `obj:method(` is `method`, which is all the baseline reads after a colon;
 * - a receiver no name spells (`items[0].Close(`, `(*T).M(`, `x.(T).M(`) names none.
 */
export function patternCallName(segments: readonly CalleeSegment[], chainDepth: number): PatternCallName | null {
  const last = segments.at(-1);
  if (!last || last.kind !== "id") return null;
  if (last.colon) return { name: last.name, leafName: last.name, line: last.line, column: last.column };
  if (segments.every((s) => s.kind === "id" && !s.colon)) {
    const ids = segments as ReadonlyArray<Extract<CalleeSegment, { kind: "id" }>>;
    const from = ids.length >= 2 ? ids[ids.length - 2]! : last;
    return { name: ids.length >= 2 ? `${from.name}.${last.name}` : last.name, leafName: last.name, line: from.line, column: from.column };
  }
  // A chain: HEAD (call) [NAME (call)]… LEAF, the head one or two names from the expression's start.
  if (chainDepth <= 0) return null;
  const headLength = segments.findIndex((s) => s.kind !== "id");
  const head = segments.slice(0, headLength) as Array<Extract<CalleeSegment, { kind: "id" }>>;
  if (headLength < 1 || headLength > 2 || head.some((h) => h.colon)) return null;
  // Between the head and the leaf: call, NAME, call, …, call.
  const steps = segments.slice(headLength, -1);
  const shaped = steps.length % 2 === 1 && steps.every((s, k) => (k % 2 === 0 ? s.kind === "call" : s.kind === "id" && !s.colon));
  const calls = (steps.length + 1) / 2;
  if (!shaped || calls > chainDepth) return null;
  const names = [head.map((h) => h.name).join("."), ...steps.filter((s) => s.kind === "id").map((s) => (s as { name: string }).name)];
  return { name: `${names.map((n) => `${n}()`).join(".")}.${last.name}`, leafName: last.name, line: head[0]!.line, column: head[0]!.column };
}

/** Calls a chain is `depth` deep in: `a.B().C` is 1. */
function chainDepthOf(name: string): number {
  return name.split("()").length - 1;
}

/**
 * The calls found, recorded as the regex scan records them — one per name, keywords and stdlib noise
 * dropped (`callRecorder`) — and in its order: line by line, and on one line the chain patterns' names
 * (shallowest first) before the baseline's, each left to right.
 */
export function recordPatternCalls(found: PatternCallName[]): CallInfo[] {
  const rank = (c: PatternCallName): number => {
    const depth = chainDepthOf(c.name);
    return depth > 0 ? depth : Number.MAX_SAFE_INTEGER;
  };
  found.sort((a, b) => a.line - b.line || rank(a) - rank(b) || a.column - b.column);
  const calls: CallInfo[] = [];
  const add = callRecorder(calls);
  for (const c of found) {
    const receiver = c.receiverType || c.receiverQualifier
      ? { ...(c.receiverType ? { receiverType: c.receiverType } : {}), ...(c.receiverQualifier ? { receiverQualifier: c.receiverQualifier } : {}) }
      : undefined;
    add(c.name, c.leafName, c.line, c.column, receiver);
  }
  return calls;
}
