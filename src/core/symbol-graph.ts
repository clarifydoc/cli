import type { Confidence, SymbolLink } from "../types/analysis.js";

/**
 * Shared symbol-call-graph primitives — the adjacency builder and BFS used by
 * both the cross-tier trace-impact pass (trace-impact.ts) and the transitive
 * data-access propagation pass (data-flow-reach.ts). Extracted so the two walk
 * the SAME edges (regular symbol links plus the synthetic HTTP/MQ links) with
 * one implementation rather than two subtly-diverging copies.
 *
 * A graph node is a `file::symbol` key; edges are directed caller → callee
 * (`forward`) with the transpose in `reverse`.
 */

export const keyOf = (file: string, symbol: string): string => `${file}::${symbol}`;
/** The file part of a `file::symbol` key. */
export const fileOf = (key: string): string => key.slice(0, key.indexOf("::"));

/** The symbol call graph as adjacency lists over `file::symbol` keys. */
export interface SymbolAdjacency {
  /** caller key → callee keys */
  forward: Map<string, string[]>;
  /** callee key → caller keys */
  reverse: Map<string, string[]>;
  /** file path → the set of symbol keys declared/linked in it */
  symbolsByFile: Map<string, Set<string>>;
  /**
   * `edgeKey(caller, callee)` → the strongest confidence of the links that
   * make the edge. A walk that must not lean on a name guess (AMBIGUOUS:
   * `unique-global*`, `route-scan`) asks it per edge.
   */
  confidence: Map<string, Confidence>;
  /** `edgeKey(caller, callee)` → the line in the caller of its first call to the callee. */
  callLine: Map<string, number>;
}

/** Key of the directed edge caller → callee in `SymbolAdjacency.confidence`. */
export const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

const CONFIDENCE_RANK: Record<Confidence, number> = { EXTRACTED: 2, INFERRED: 1, AMBIGUOUS: 0 };

/** The weaker of two confidences — a path is only as sure as its weakest link. */
export function weakest(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/** Comparator: stronger confidence first. */
export function strongerFirst(a: Confidence, b: Confidence): number {
  return CONFIDENCE_RANK[b] - CONFIDENCE_RANK[a];
}

/**
 * Build forward + reverse adjacency (and a per-file symbol index) from the
 * project's symbol links, de-duplicating parallel edges. Behavior is identical
 * to the inline builder trace-impact.ts previously used.
 */
/** One adjacency per links array (and length): the trace impact and the finding and pattern entries read the same links. */
const ADJACENCY = new WeakMap<readonly SymbolLink[], { length: number; adjacency: SymbolAdjacency }>();

/** The links' adjacency, built once per array; callers read it and never change it. */
export function buildSymbolAdjacency(symbolLinks: readonly SymbolLink[]): SymbolAdjacency {
  const hit = ADJACENCY.get(symbolLinks);
  if (hit && hit.length === symbolLinks.length) return hit.adjacency;
  const adjacency = buildAdjacency(symbolLinks);
  ADJACENCY.set(symbolLinks, { length: symbolLinks.length, adjacency });
  return adjacency;
}

function buildAdjacency(symbolLinks: readonly SymbolLink[]): SymbolAdjacency {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const symbolsByFile = new Map<string, Set<string>>();
  const addSym = (file: string, key: string): void => {
    let set = symbolsByFile.get(file);
    if (!set) symbolsByFile.set(file, (set = new Set()));
    set.add(key);
  };
  const edgeSeen = new Set<string>();
  const confidence = new Map<string, Confidence>();
  const callLine = new Map<string, number>();
  for (const l of symbolLinks) {
    const src = keyOf(l.sourceFile, l.sourceSymbol);
    const tgt = keyOf(l.targetFile, l.targetSymbol);
    addSym(l.sourceFile, src);
    addSym(l.targetFile, tgt);
    const ck = edgeKey(src, tgt);
    const prev = confidence.get(ck);
    const conf = l.confidence ?? "INFERRED";
    if (!callLine.has(ck)) callLine.set(ck, l.sourceLine);
    if (prev === undefined) confidence.set(ck, conf);
    else if (strongerFirst(conf, prev) < 0) confidence.set(ck, conf);
    // NUL separator (`edgeKey`): file paths/symbols may contain spaces but
    // never NUL, so the (src, tgt) dedup key can't collide across distinct edges.
    if (edgeSeen.has(ck)) continue;
    edgeSeen.add(ck);
    let f = forward.get(src);
    if (!f) forward.set(src, (f = []));
    f.push(tgt);
    let r = reverse.get(tgt);
    if (!r) reverse.set(tgt, (r = []));
    r.push(src);
  }
  return { forward, reverse, symbolsByFile, confidence, callLine };
}

/**
 * BFS over an adjacency map from a set of roots; calls `visit()` for every key
 * reached (roots included). Cycle-safe via a visited set; visits in
 * shortest-path (breadth) order.
 */
export function bfs(
  roots: Iterable<string>,
  adj: Map<string, string[]>,
  visit: (key: string) => void,
): void {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) {
    if (!visited.has(r)) {
      visited.add(r);
      queue.push(r);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const k = queue[qi++]!;
    visit(k);
    for (const next of adj.get(k) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
}

/**
 * Context-sensitive reach through dispatches back to a component's user.
 *
 * A child's emit, callback-prop call or dialog close is one link per binding
 * (`SymbolLink.viaUsage`), but a call graph has one node per function: a walk
 * that enters a shared `<ConfirmDialog>` from `ClubPage` and leaves through its
 * `confirm` would reach every page's handler. The gate keeps the walk's last
 * cross-file entry (one level of context) and lets it leave a child file
 * through a bound link only back to a file binding it there — or when the file
 * it came from binds the child nowhere (an unknown instance: nothing to tell
 * the bindings apart by, so all of them stay). A walk that starts inside the
 * child has no entry and takes every binding.
 *
 * States are opaque strings, `""` for none, so a walk keys its visited set by
 * node and state (`stateNode`); with no bound link in the project every state
 * is `""` and a walk behaves exactly as without the gate.
 */
export interface UsageGate {
  /** Whether any link carries binding sites. */
  readonly active: boolean;
  /** The state after the forward step caller → callee, or null when the gate refuses it. */
  forward(state: string, caller: string, callee: string): string | null;
  /** The state after the reverse step callee → caller (a walk from effects back to entries), or null when refused. */
  reverse(state: string, callee: string, caller: string): string | null;
}

/** A node of a gated walk: the key, and its state when there is one. */
export const stateNode = (key: string, state: string): string => (state ? `${key}\u0001${state}` : key);
/** The `file::symbol` key of a `stateNode`. */
export const nodeKey = (node: string): string => {
  const i = node.indexOf("\u0001");
  return i < 0 ? node : node.slice(0, i);
};

/** What the gate reads of a link: its ends and binding sites (a summary read back from disk has the same). */
type GateLink = Pick<SymbolLink, "sourceFile" | "sourceSymbol" | "targetFile" | "targetSymbol" | "viaUsage">;
const GATES = new WeakMap<readonly GateLink[], { length: number; gate: UsageGate }>();
const OPEN_GATE: UsageGate = { active: false, forward: () => "", reverse: () => "" };

/** The links' usage gate, built once per array. */
export function usageGate(symbolLinks: readonly GateLink[]): UsageGate {
  const hit = GATES.get(symbolLinks);
  if (hit && hit.length === symbolLinks.length) return hit.gate;
  const gate = buildUsageGate(symbolLinks);
  GATES.set(symbolLinks, { length: symbolLinks.length, gate });
  return gate;
}

function buildUsageGate(symbolLinks: readonly GateLink[]): UsageGate {
  // Edge → the files binding it; an edge one link states no binding for is open to every entry.
  const bound = new Map<string, Set<string> | null>();
  for (const l of symbolLinks) {
    const ek = edgeKey(keyOf(l.sourceFile, l.sourceSymbol), keyOf(l.targetFile, l.targetSymbol));
    const prev = bound.get(ek);
    if (prev === null) continue;
    if (!l.viaUsage?.length) {
      bound.set(ek, null);
      continue;
    }
    const files = prev ?? new Set<string>();
    for (const u of l.viaUsage) files.add(u.file);
    bound.set(ek, files);
  }
  // Child file → every file binding something of it.
  const binders = new Map<string, Set<string>>();
  const filesOf = new Map<string, Set<string>>();
  for (const [ek, files] of bound) {
    if (!files) continue;
    filesOf.set(ek, files);
    const child = fileOf(ek.slice(0, ek.indexOf("\u0000")));
    const set = binders.get(child) ?? binders.set(child, new Set()).get(child)!;
    for (const f of files) set.add(f);
  }
  if (filesOf.size === 0) return OPEN_GATE;
  // The file a walk entered a child from may lead out through a binding when it binds the child there, or nowhere.
  const admits = (child: string, entry: string, files: ReadonlySet<string>): boolean => files.has(entry) || !binders.get(child)?.has(entry);
  // Forward state: `<child file>\u0002<file it was entered from>`.
  // Reverse state: `<child file>\u0002<binding files, \u0003-joined>` — the bindings the walk left the child by.
  const split = (state: string): [string, string] => {
    const i = state.indexOf("\u0002");
    return [state.slice(0, i), state.slice(i + 1)];
  };
  return {
    active: true,
    forward(state, caller, callee) {
      const from = fileOf(caller);
      const to = fileOf(callee);
      const files = filesOf.get(edgeKey(caller, callee));
      if (files && state) {
        const [child, entry] = split(state);
        if (child === from && !admits(child, entry, files)) return null;
      }
      return from === to ? state : `${to}\u0002${from}`;
    },
    reverse(state, callee, caller) {
      const from = fileOf(caller);
      const at = fileOf(callee);
      if (state) {
        const [child, joined] = split(state);
        if (from !== child && !admits(child, from, new Set(joined.split("\u0003")))) return null;
      }
      const files = filesOf.get(edgeKey(caller, callee));
      if (files) return `${from}\u0002${[...files].sort().join("\u0003")}`;
      return from === at ? state : "";
    },
  };
}
