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
