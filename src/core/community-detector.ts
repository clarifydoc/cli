import type { LinkInfo } from "../types/analysis.js";

/**
 * Hand-rolled Louvain community detection — no external graph libraries.
 *
 * Models ClarifyDoc's directed linkGraph as an undirected weighted graph (parallel
 * edges are summed). Runs the classic two-phase Louvain loop: local
 * modularity-maximizing moves → contract → repeat until no improvement.
 *
 * Mirrors graphify-7's cluster.py:
 *   - Communities larger than 25% of the node count are re-Louvained on their subgraph
 *   - Isolates each get their own one-node community
 *   - Final community IDs are stable: 0 = largest, sorted by size descending
 *   - Cohesion is intra-community edges / max possible
 *
 * Capped at 5000 nodes — above that we bail with empty results rather than
 * spend minutes on a graph the user probably doesn't want clustered.
 */

const MAX_COMMUNITY_FRACTION = 0.25;
const MIN_SPLIT_SIZE = 10;
const MAX_NODES = 5000;
/** Inverted proximity weight: tight (1) → 3, loose (3) → 1. */
function proximityWeight(proximity: number): number {
  return Math.max(1, 4 - proximity);
}

/**
 * Communities found by `detectCommunities`. Both maps are empty when the
 * graph had no files or exceeded the node cap.
 */
export interface CommunityResult {
  /** Map community ID (stringified number) → sorted list of file paths. */
  communities: Record<string, string[]>;
  /** Map community ID → cohesion ∈ [0, 1]. */
  cohesion: Record<string, number>;
}

interface AdjacencyMap {
  /** node → (neighbor → summed weight). */
  edges: Map<string, Map<string, number>>;
  /** node → sum of incident edge weights. */
  degree: Map<string, number>;
  /** Sum of all edge weights × 2 (each edge contributes to both endpoints). */
  m2: number;
}

/**
 * Cluster the project's files into communities by Louvain modularity over the
 * link graph (see the module comment for the algorithm and its caps).
 *
 * @param linkGraph - Proximity-weighted file links; direction is ignored
 * @param files - Every file to place, including ones with no links (isolates)
 * @returns Communities numbered by descending size, with their cohesion
 */
export function detectCommunities(linkGraph: LinkInfo[], files: string[]): CommunityResult {
  if (files.length === 0) return { communities: {}, cohesion: {} };
  if (files.length > MAX_NODES) {
    return { communities: {}, cohesion: {} };
  }

  const adj = buildUndirectedAdj(linkGraph, files);
  const nodes = files.slice();

  // Isolates (no incident edges) — group each as its own singleton at the end.
  const isolates: string[] = [];
  const connected: string[] = [];
  for (const n of nodes) {
    if ((adj.degree.get(n) ?? 0) === 0) isolates.push(n);
    else connected.push(n);
  }

  let partitions: string[][] = [];
  if (connected.length > 0) {
    const partition = runLouvain(connected, adj);
    partitions = bucketByCommunity(partition);
  }

  // Each isolate becomes its own community.
  for (const iso of isolates) partitions.push([iso]);

  // Split oversized communities by re-Louvaining their subgraphs.
  const maxSize = Math.max(MIN_SPLIT_SIZE, Math.floor(nodes.length * MAX_COMMUNITY_FRACTION));
  const final: string[][] = [];
  for (const community of partitions) {
    if (community.length > maxSize) {
      final.push(...splitCommunity(community, adj));
    } else {
      final.push(community);
    }
  }

  // Sort: largest first, deterministic order within each community.
  final.sort((a, b) => b.length - a.length);
  const communities: Record<string, string[]> = {};
  const cohesion: Record<string, number> = {};
  for (let i = 0; i < final.length; i++) {
    const sorted = final[i]!.slice().sort();
    communities[String(i)] = sorted;
    cohesion[String(i)] = cohesionScore(sorted, adj);
  }
  return { communities, cohesion };
}

/** Symmetric weighted adjacency map. Parallel + reversed edges are summed. */
function buildUndirectedAdj(linkGraph: LinkInfo[], files: string[]): AdjacencyMap {
  const edges = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();
  for (const f of files) {
    edges.set(f, new Map());
    degree.set(f, 0);
  }

  let m2 = 0;
  for (const link of linkGraph) {
    if (link.source === link.target) continue;
    if (!edges.has(link.source) || !edges.has(link.target)) continue;
    const w = proximityWeight(link.proximity);
    addUndirectedEdge(edges, link.source, link.target, w);
    degree.set(link.source, (degree.get(link.source) ?? 0) + w);
    degree.set(link.target, (degree.get(link.target) ?? 0) + w);
    m2 += 2 * w;
  }
  return { edges, degree, m2 };
}

/** Add weight `w` to the a–b edge in both directions, summing parallel edges. */
function addUndirectedEdge(
  edges: Map<string, Map<string, number>>,
  a: string,
  b: string,
  w: number,
): void {
  const ea = edges.get(a)!;
  const eb = edges.get(b)!;
  ea.set(b, (ea.get(b) ?? 0) + w);
  eb.set(a, (eb.get(a) ?? 0) + w);
}

/**
 * One pass of Louvain on the given nodes against the global adjacency.
 * Returns node → community-id map. Iterates until no node move improves
 * modularity OR a max-iteration safety cap fires.
 */
function runLouvain(nodes: string[], adj: AdjacencyMap): Map<string, number> {
  // Each node starts in its own community.
  const community = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) community.set(nodes[i]!, i);

  // Sum of incident weights per community — needed for modularity gain math.
  const commWeight = new Map<number, number>();
  for (const n of nodes) {
    const c = community.get(n)!;
    commWeight.set(c, (commWeight.get(c) ?? 0) + (adj.degree.get(n) ?? 0));
  }

  const m2 = adj.m2 || 1; // avoid /0 in single-isolated-edge case
  const MAX_ITER = 30;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let moved = false;
    for (const n of nodes) {
      const currentComm = community.get(n)!;
      const k = adj.degree.get(n) ?? 0;

      // Sum weights from n to each neighbor community (deduplicated).
      const toComm = new Map<number, number>();
      const edges = adj.edges.get(n);
      if (!edges) continue;
      for (const [neighbor, w] of edges) {
        const c = community.get(neighbor);
        if (c === undefined) continue;
        toComm.set(c, (toComm.get(c) ?? 0) + w);
      }

      // Modularity gain if we move n from currentComm to candidate c:
      //   ΔQ ∝ (k_in_c - k_in_currentComm) - k * (Σtot_c - Σtot_currentComm + k) / m
      // We compute it as the difference between "move to c" and "stay".
      const stayGain = (toComm.get(currentComm) ?? 0)
        - k * ((commWeight.get(currentComm) ?? 0) - k) / m2;

      let bestComm = currentComm;
      let bestGain = stayGain;
      for (const [c, w] of toComm) {
        if (c === currentComm) continue;
        const gain = w - k * (commWeight.get(c) ?? 0) / m2;
        if (gain > bestGain + 1e-9) {
          bestGain = gain;
          bestComm = c;
        }
      }
      if (bestComm !== currentComm) {
        commWeight.set(currentComm, (commWeight.get(currentComm) ?? 0) - k);
        commWeight.set(bestComm, (commWeight.get(bestComm) ?? 0) + k);
        community.set(n, bestComm);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return community;
}

/** Group the nodes of a partition into one array per community id. */
function bucketByCommunity(partition: Map<string, number>): string[][] {
  const buckets = new Map<number, string[]>();
  for (const [node, c] of partition) {
    const arr = buckets.get(c);
    if (arr) arr.push(node);
    else buckets.set(c, [node]);
  }
  return [...buckets.values()];
}

/** Re-run Louvain on a single oversized community's subgraph. */
function splitCommunity(nodes: string[], adj: AdjacencyMap): string[][] {
  // Build a sub-adjacency restricted to `nodes`.
  const nodeSet = new Set(nodes);
  const subEdges = new Map<string, Map<string, number>>();
  const subDegree = new Map<string, number>();
  let m2 = 0;
  for (const n of nodes) {
    subEdges.set(n, new Map());
    subDegree.set(n, 0);
  }
  for (const n of nodes) {
    const fullEdges = adj.edges.get(n);
    if (!fullEdges) continue;
    for (const [neighbor, w] of fullEdges) {
      if (!nodeSet.has(neighbor)) continue;
      subEdges.get(n)!.set(neighbor, w);
      subDegree.set(n, (subDegree.get(n) ?? 0) + w);
      m2 += w; // each pair will be counted twice via both endpoints below; here we'd double — but since we iterate both endpoints, normalize
    }
  }
  // We doubled-counted m2 (each edge once per endpoint). m2 should equal 2 × sum-of-edge-weights.
  const subAdj: AdjacencyMap = { edges: subEdges, degree: subDegree, m2 };
  const partition = runLouvain(nodes, subAdj);
  const buckets = bucketByCommunity(partition);
  return buckets.length > 1 ? buckets : [nodes];
}

/** intra-community edges / max possible. Higher = more cohesive. */
function cohesionScore(community: string[], adj: AdjacencyMap): number {
  const n = community.length;
  if (n <= 1) return 1;
  const inSet = new Set(community);
  let intra = 0;
  for (const node of community) {
    const edges = adj.edges.get(node);
    if (!edges) continue;
    for (const neighbor of edges.keys()) {
      if (inSet.has(neighbor)) intra++;
    }
  }
  // Each edge was counted twice (once per endpoint).
  intra = intra / 2;
  const possible = (n * (n - 1)) / 2;
  return possible > 0 ? Math.round((intra / possible) * 100) / 100 : 0;
}
