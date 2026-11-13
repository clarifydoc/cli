/**
 * Call names for a parser front end (ANTLR or tree-sitter), spelled as the regex call scan spells them (regex-base.ts
 * `extractCallsFromBody` and `callChainPatterns`), so a parsed call reaches the linker under the name the
 * pattern reading would have given it. The parser decides WHAT is a call; this decides only its name.
 */

import type { CallInfo } from "../../../types/analysis.js";
import { callRecorder, type CallArguments } from "./regex-base.js";

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
  /** The name spells only the receiver's last names (`CallInfo.receiverCut`): `league.relegate` for `items[0].league.relegate(`. */
  receiverCut?: true;
  /** The scan's name for a path named from an untyped head (`CallInfo.fallbackName`). */
  fallbackName?: string;
  /** A bare name the function binds itself — a parameter or a local it calls (`CallInfo.boundLocally`). */
  boundLocally?: true;
  /** The name is handed on, not called here (`CallInfo.passed`): Qt's `&ClubWindow::saveClub` slot argument. */
  passed?: "argument";
  /** The arguments the call passes, as the parse reads them; calls of one name differing in them are separate rows. */
  args?: CallArguments;
}

/**
 * A name a function binds where the parse shows it — a parameter, a local (`auto kick = [](int x) { … };`, a
 * `std::function` or a function pointer) — from its declaration (`line`/`column` of the name) to the end of the
 * scope declaring it (`endLine`/`endColumn`, the closing token of the block, statement, lambda or function).
 */
export interface LocalBinding {
  name: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/**
 * Marks each bare call (`kick(3)`) a binding in `bindings` answers at the call's position `boundLocally`: the
 * function calls its own value, never the file-level function or the import of that name.
 */
export function markLocalCalls(calls: PatternCallName[], bindings: readonly LocalBinding[]): void {
  if (bindings.length === 0) return;
  const before = (l1: number, c1: number, l2: number, c2: number): boolean => l1 < l2 || (l1 === l2 && c1 < c2);
  for (const call of calls) {
    if (call.name !== call.leafName || call.receiverType || call.receiverQualifier) continue;
    const bound = bindings.some((b) => b.name === call.name
      && before(b.line, b.column, call.line, call.column) && !before(b.endLine, b.endColumn, call.line, call.column));
    if (bound) call.boundLocally = true;
  }
}

/**
 * The name the regex scan gives a call whose callee is `segments`, or null when it names none:
 * - a selector path is its last two names — `s.repo.Find(` is `repo.Find`, as the baseline pattern reads it;
 * - a member called on a call's result is the chain from a head of one or two names, at most `chainDepth`
 *   calls deep — `pb.NewClient(conn).Get(` is `pb.NewClient().Get` (0 when the language has no chain patterns);
 * - a Lua `obj:method(` is `obj.method`, a chain's (`a.b:method(`) just `method`, which is all the baseline reads after a colon;
 * - a receiver no name spells (`items[0].Close(`, `(*T).M(`, `x.(T).M(`) names none.
 */
export function patternCallName(segments: readonly CalleeSegment[], chainDepth: number): PatternCallName | null {
  const last = segments.at(-1);
  if (!last || last.kind !== "id") return null;
  if (last.colon) {
    // `obj:method(` is a call on `obj` — Lua's `self:warmup()` and `mate:warmup()` are two receivers' — when a plain name precedes.
    const receiver = segments.length === 2 ? segments[0]! : undefined;
    if (receiver?.kind === "id" && !receiver.colon) return { name: `${receiver.name}.${last.name}`, leafName: last.name, line: receiver.line, column: receiver.column };
    return { name: last.name, leafName: last.name, line: last.line, column: last.column };
  }
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
export function recordPatternCalls(
  found: PatternCallName[],
  /** Names the language's own patterns give (C++'s `Club::create(`, `std::find(`): the scan records them before the baseline's. */
  patternNamed?: (c: PatternCallName) => boolean,
): CallInfo[] {
  const rank = (c: PatternCallName): number => {
    const depth = chainDepthOf(c.name);
    return depth > 0 ? depth : patternNamed?.(c) ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
  };
  found.sort((a, b) => a.line - b.line || rank(a) - rank(b) || a.column - b.column);
  const calls: CallInfo[] = [];
  const add = callRecorder(calls);
  // A name called once as a local's and once as the file's function (`{ auto kick = …; kick(1); } kick(2);`) is two
  // calls: each recorded once, the local's marked.
  const bound: CallInfo[] = [];
  const addBound = callRecorder(bound);
  const handed: PatternCallName[] = [];
  for (const c of found) {
    if (c.passed) {
      handed.push(c);
      continue;
    }
    if (c.boundLocally) {
      const at = bound.length;
      addBound(c.name, c.leafName, c.line, c.column);
      for (const b of bound.slice(at)) calls.push({ ...b, boundLocally: true });
      continue;
    }
    const receiver = c.receiverType || c.receiverQualifier || c.receiverCut || c.fallbackName
      ? {
        ...(c.receiverType ? { receiverType: c.receiverType } : {}),
        ...(c.receiverQualifier ? { receiverQualifier: c.receiverQualifier } : {}),
        ...(c.receiverCut ? { receiverCut: true } : {}),
        ...(c.fallbackName ? { fallbackName: c.fallbackName } : {}),
      }
      : undefined;
    add(c.name, c.leafName, c.line, c.column, c.args ? { ...receiver, args: c.args } : receiver);
  }
  // A name handed on is a reference of its own; a name the function also calls is a call already.
  const invoked = new Set(calls.map((c) => c.name));
  for (const c of handed) {
    if (invoked.has(c.name)) continue;
    invoked.add(c.name);
    calls.push({
      name: c.name, kind: "internal", target: null, line: c.line, column: c.column, passed: c.passed!,
      ...(c.receiverType ? { receiverType: c.receiverType } : {}),
    });
  }
  return calls;
}
