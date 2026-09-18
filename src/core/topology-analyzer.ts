import type { LinkInfo, Confidence } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { SURPRISE_RANK as CONFIDENCE_RANK } from "../extractors/shared/confidence.js";

/**
 * Graph-topology-derived insights. Three outputs:
 *
 *   - godNodes: files with the highest combined in+out degree. The structural
 *     core of the project — everything routes through these.
 *
 *   - surprisingConnections: edges that look non-obvious. Scored by a
 *     composite of confidence (AMBIGUOUS scores higher), cross-community
 *     boundary, and peripheral→hub shape. Mirrors graphify-7's `_surprise_score`.
 *
 *   - suggestedQuestions: human-readable prompts the graph is uniquely
 *     positioned to answer. Drawn from AMBIGUOUS edges, bridge nodes,
 *     isolated nodes, and low-cohesion communities.
 *
 * All three are derived from the existing link/component graphs — no extra
 * extraction. Capped at 1000 nodes for betweenness; above that we fall back
 * to degree centrality so the analyzer never hangs on big repos.
 */

const BETWEENNESS_NODE_CAP = 1000;

export interface GodNode {
  file: string;
  degree: number;
}

export interface SurprisingConnection {
  source: string;
  target: string;
  confidence?: Confidence;
  relation: string;
  score: number;
  reason: string;
}

export type SuggestedQuestionType =
  | "ambiguous-edge"
  | "bridge-node"
  | "isolated-node"
  | "low-cohesion";

export interface SuggestedQuestion {
  type: SuggestedQuestionType;
  question: string;
  why: string;
}

/** Top-N files by combined in+out degree (file-stub filter: degree must be > 0). */
export function findGodNodes(
  componentGraph: Record<string, string[]>,
  files: string[],
  topN = 10,
): GodNode[] {
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const f of files) {
    inDeg.set(f, 0);
    outDeg.set(f, 0);
  }
  for (const [src, targets] of Object.entries(componentGraph)) {
    outDeg.set(src, (outDeg.get(src) ?? 0) + targets.length);
    for (const t of targets) inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
  }

  const all: GodNode[] = files
    .map((f) => ({ file: f, degree: (inDeg.get(f) ?? 0) + (outDeg.get(f) ?? 0) }))
    .filter((n) => n.degree > 0);
  all.sort((a, b) => b.degree - a.degree || byOrdinal(a.file, b.file));
  return all.slice(0, topN);
}

/**
 * Score every cross-community link by how surprising it is. Returns the top-N
 * by score. Skips imports/contains (structural noise) and same-community pairs
 * (a graph claiming "X is connected to Y" is not surprising when Leiden already
 * grouped them together).
 */
export function findSurprisingConnections(
  linkGraph: LinkInfo[],
  communities: Record<string, string[]>,
  componentGraph: Record<string, string[]>,
  topN = 5,
): SurprisingConnection[] {
  const fileCommunity = invertCommunities(communities);
  const degree = degreeMap(componentGraph);

  const scored: SurprisingConnection[] = [];
  for (const link of linkGraph) {
    if (link.source === link.target) continue;
    const reasons: string[] = [];
    let score = 0;

    const confRank = link.confidence ? CONFIDENCE_RANK[link.confidence] : 1;
    score += confRank;
    if (link.confidence === "AMBIGUOUS" || link.confidence === "INFERRED") {
      reasons.push(`${link.confidence.toLowerCase()} connection — not explicit in source`);
    }

    const sc = fileCommunity.get(link.source);
    const tc = fileCommunity.get(link.target);
    if (sc !== undefined && tc !== undefined && sc !== tc) {
      score += 2;
      reasons.push("bridges separate communities");
    }

    const ds = degree.get(link.source) ?? 0;
    const dt = degree.get(link.target) ?? 0;
    if (Math.min(ds, dt) <= 2 && Math.max(ds, dt) >= 5) {
      score += 1;
      reasons.push("peripheral file unexpectedly reaches a hub");
    }

    if (score >= 4) {
      scored.push({
        source: link.source,
        target: link.target,
        confidence: link.confidence,
        relation: link.reason,
        score,
        reason: reasons.join("; "),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/**
 * Generate questions the graph is uniquely positioned to answer. Each entry
 * carries the question itself plus the why (the topological signal that
 * surfaced it).
 */
export function suggestQuestions(
  linkGraph: LinkInfo[],
  communities: Record<string, string[]>,
  cohesion: Record<string, number>,
  componentGraph: Record<string, string[]>,
  files: string[],
  topN = 7,
): SuggestedQuestion[] {
  const questions: SuggestedQuestion[] = [];

  // 1. AMBIGUOUS edges
  const ambiguous = linkGraph.filter((l) => l.confidence === "AMBIGUOUS");
  for (const link of ambiguous.slice(0, 3)) {
    questions.push({
      type: "ambiguous-edge",
      question: `Is the link between \`${link.source}\` and \`${link.target}\` real, or did the resolver guess?`,
      why: `Edge tagged AMBIGUOUS (${link.reason}) — confidence is low.`,
    });
  }

  // 2. Bridge nodes via betweenness centrality (or degree fallback on big graphs)
  const bridges = files.length <= BETWEENNESS_NODE_CAP
    ? topBetweenness(componentGraph, files, 3)
    : topDegree(componentGraph, files, 3);
  const fileCommunity = invertCommunities(communities);
  for (const { file, score } of bridges) {
    const myCommunity = fileCommunity.get(file);
    const neighborCommunities = new Set<string>();
    for (const other of componentGraph[file] ?? []) {
      const c = fileCommunity.get(other);
      if (c !== undefined && c !== myCommunity) neighborCommunities.add(c);
    }
    if (neighborCommunities.size > 0) {
      questions.push({
        type: "bridge-node",
        question: `Why does \`${file}\` connect ${neighborCommunities.size} otherwise-separate communities?`,
        why: `High centrality (${score.toFixed(3)}) — this file is a cross-community bridge.`,
      });
    }
  }

  // 3. Isolated nodes
  const degree = degreeMap(componentGraph);
  const isolated = files.filter((f) => (degree.get(f) ?? 0) <= 1);
  if (isolated.length > 0) {
    const sample = isolated.slice(0, 3).map((f) => `\`${f}\``).join(", ");
    questions.push({
      type: "isolated-node",
      question: `What connects ${sample} to the rest of the system?`,
      why: `${isolated.length} weakly-connected file(s) — possible missing edges or undocumented components.`,
    });
  }

  // 4. Low-cohesion communities
  for (const [cid, score] of Object.entries(cohesion)) {
    const size = communities[cid]?.length ?? 0;
    if (score < 0.15 && size >= 5) {
      questions.push({
        type: "low-cohesion",
        question: `Should community ${cid} (${size} files) be split into smaller, more focused modules?`,
        why: `Cohesion score ${score} — nodes in this community are weakly interconnected.`,
      });
    }
  }

  return questions.slice(0, topN);
}

// ── helpers ────────────────────────────────────────────────────────────────

function invertCommunities(communities: Record<string, string[]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [cid, files] of Object.entries(communities)) {
    for (const f of files) m.set(f, cid);
  }
  return m;
}

function degreeMap(componentGraph: Record<string, string[]>): Map<string, number> {
  const deg = new Map<string, number>();
  for (const [src, targets] of Object.entries(componentGraph)) {
    deg.set(src, (deg.get(src) ?? 0) + targets.length);
    for (const t of targets) deg.set(t, (deg.get(t) ?? 0) + 1);
  }
  return deg;
}

function topDegree(
  componentGraph: Record<string, string[]>,
  files: string[],
  k: number,
): Array<{ file: string; score: number }> {
  const deg = degreeMap(componentGraph);
  return files
    .map((f) => ({ file: f, score: deg.get(f) ?? 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byOrdinal(a.file, b.file))
    .slice(0, k);
}

/**
 * Brandes betweenness centrality on an unweighted directed graph treated as
 * undirected for path counting. Returns the top-K nodes by score.
 *
 * Runs O(V * (V + E)). Capped via BETWEENNESS_NODE_CAP at call site.
 */
function topBetweenness(
  componentGraph: Record<string, string[]>,
  files: string[],
  k: number,
): Array<{ file: string; score: number }> {
  // Build undirected adjacency.
  const adj = new Map<string, Set<string>>();
  for (const f of files) adj.set(f, new Set());
  for (const [src, targets] of Object.entries(componentGraph)) {
    if (!adj.has(src)) adj.set(src, new Set());
    for (const t of targets) {
      if (!adj.has(t)) adj.set(t, new Set());
      adj.get(src)!.add(t);
      adj.get(t)!.add(src);
    }
  }

  const cb = new Map<string, number>();
  for (const s of adj.keys()) cb.set(s, 0);

  for (const s of adj.keys()) {
    const stack: string[] = [];
    const pred = new Map<string, string[]>();
    const sigma = new Map<string, number>();
    const dist = new Map<string, number>();
    for (const v of adj.keys()) {
      pred.set(v, []);
      sigma.set(v, 0);
      dist.set(v, -1);
    }
    sigma.set(s, 1);
    dist.set(s, 0);
    // Index-pointer queue — Array.shift is O(V), and the BFS runs V times
    // per outer iteration, so naive shift turns Brandes into O(V³) for
    // sparse graphs. Pushing + tracking a head index gives true O(V + E).
    const queue: string[] = [s];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++]!;
      stack.push(v);
      for (const w of adj.get(v) ?? []) {
        if (dist.get(w)! < 0) {
          dist.set(w, dist.get(v)! + 1);
          queue.push(w);
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }
    const delta = new Map<string, number>();
    for (const v of adj.keys()) delta.set(v, 0);
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) {
        delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!));
      }
      if (w !== s) cb.set(w, cb.get(w)! + delta.get(w)!);
    }
  }

  const n = adj.size;
  const norm = n > 2 ? 1 / ((n - 1) * (n - 2)) : 1;

  return [...cb.entries()]
    .map(([file, score]) => ({ file, score: score * norm }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byOrdinal(a.file, b.file))
    .slice(0, k);
}
