import type { BlastRadiusInfo, BlastSymbolUsage, ContextBurden, SymbolLink } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";

/**
 * Analyze blast radius for each file using the component graph and symbol links.
 * Determines:
 * - Which files would be affected if a given file changes (direct + transitive)
 * - Which exported symbols are consumed externally and by whom
 * - The file's own fragility (what it depends on)
 * - Change risk classification
 */
/**
 * Stored-list caps. The COUNT fields (directDependents, transitiveDependents,
 * usedByCount) stay exact; only the enumerated lists are truncated — the
 * transitive closure is O(files²) on hub-dense repos (a 5k-file corpus
 * produced 213MB of transitiveFiles strings in one report payload) and
 * unreadable long before that. Transitive entries keep BFS discovery order,
 * so the capped list holds the NEAREST dependents.
 */
const AFFECTED_LIST_CAP = 500;
const TRANSITIVE_LIST_CAP = 50;
const CALLERS_LIST_CAP = 10;

/** Context burden reach: two hops covers direct neighbours and their neighbours. */
const CONTEXT_HOPS = 2;
/** ≈40 characters per source line at ≈4 characters per token. */
const TOKENS_PER_LINE = 10;

/**
 * Optional inputs that refine the blast-radius figures without changing which
 * files are affected.
 */
export interface BlastRadiusOptions {
  /** Physical line count per file (from `FileAnalysis.lineCount`); sizes the context burden. */
  lineCounts?: ReadonlyMap<string, number>;
}

/**
 * The import graph over file indices: `forward[i]` the files `i` imports, `reverse[i]` the files importing
 * it, each in the order the string-keyed graph lists them — a walk over these visits files in the order
 * a walk over the names would. Every file gets one walk per analysis; on names that was a `Set<string>`
 * per file, most of this pass's time.
 */
interface IndexedGraph {
  names: string[];
  forward: number[][];
  reverse: number[][];
}

function indexGraph(componentGraph: Record<string, string[]>): IndexedGraph {
  const ids = new Map<string, number>();
  const names: string[] = [];
  const idOf = (name: string): number => {
    let id = ids.get(name);
    if (id === undefined) {
      id = names.length;
      ids.set(name, id);
      names.push(name);
    }
    return id;
  };
  const entries = Object.entries(componentGraph);
  // Ids in the order the files first appear: a source, then its targets.
  for (const [source, targets] of entries) {
    idOf(source);
    for (const t of targets) idOf(t);
  }
  const forward: number[][] = names.map(() => []);
  const reverse: number[][] = names.map(() => []);
  for (const [source, targets] of entries) {
    const s = ids.get(source)!;
    const out = forward[s]!;
    for (const target of targets) {
      const t = ids.get(target)!;
      out.push(t);
      // One source's entries for a target are added back to back, so a repeat is the last one.
      const back = reverse[t]!;
      if (back[back.length - 1] !== s) back.push(s);
    }
  }
  return { names, forward, reverse };
}

/**
 * The files an editor must hold in mind to change `start` safely: everything
 * within `hops` hops following imports in BOTH directions. Downstream files
 * break when the contract changes; upstream files define the contracts being
 * relied on. Self is excluded from the count but included in the size.
 */
function contextBurdenFor(
  start: number,
  graph: IndexedGraph,
  lineCounts: readonly (number | undefined)[] | undefined,
  hops: number,
  seen: Uint32Array,
  stamp: number,
): ContextBurden {
  seen[start] = stamp;
  const visited = [start];
  let from = 0;
  for (let hop = 0; hop < hops && from < visited.length; hop++) {
    const to = visited.length;
    for (let i = from; i < to; i++) {
      const node = visited[i]!;
      for (const n of graph.forward[node]!) if (seen[n] !== stamp) { seen[n] = stamp; visited.push(n); }
      for (const n of graph.reverse[node]!) if (seen[n] !== stamp) { seen[n] = stamp; visited.push(n); }
    }
    from = to;
  }
  let lines: number | null = null;
  if (lineCounts) {
    for (const f of visited) {
      const n = lineCounts[f];
      if (n !== undefined) lines = (lines ?? 0) + n;
    }
  }
  return {
    files: visited.length - 1,
    lines,
    estimatedTokens: lines === null ? null : lines * TOKENS_PER_LINE,
  };
}

/**
 * Compute the blast radius of every file in the component graph.
 *
 * For each file this reports who depends on it (direct and transitive, via the
 * reversed import graph), which of its symbols are called from other files
 * and from where (via `symbolLinks`), what the file itself depends on, a
 * change-risk class, and the context burden an editor carries to change it.
 * Enumerated lists are capped (see the caps at the top of this module); the
 * counts stay exact.
 *
 * @param componentGraph - file → files it imports
 * @param symbolLinks - Resolved call→definition links, for per-symbol usage
 * @param totalFiles - Project file count; accepted by the signature but not consulted
 *   by the current classification
 * @param options - Line counts for the context burden
 * @returns One entry per file, in file order
 */
export function analyzeBlastRadius(
  componentGraph: Record<string, string[]>,
  symbolLinks: SymbolLink[],
  totalFiles: number,
  options: BlastRadiusOptions = {},
): BlastRadiusInfo[] {
  const graph = indexGraph(componentGraph);
  const { names, reverse } = graph;
  const fileCount = names.length;
  const lineCounts = options.lineCounts ? names.map((n) => options.lineCounts!.get(n)) : undefined;

  // ── Build per-symbol usage from symbolLinks ──
  // targetFile → (symbolName → caller sites)
  const fileExportedSymbols = new Map<string, Map<string, { file: string; line: number }[]>>();

  // Per-symbol caller sites, deduped by (file, line). Multiple SymbolLinks can
  // share the same call site — e.g. one emitted by the text-linker scoped to the
  // enclosing function, and one emitted by LSP findReferences with a generic
  // "(reference)" sourceSymbol (`relation: "reference"`, `strategy:
  // "lsp-reference"`). They're correctly distinct at the graph layer
  // (symbol-dedup keeps both), but the caller list only cares about unique sites.
  const callerSeen = new Map<string, Set<string>>();
  for (const link of symbolLinks) {
    if (link.sourceFile === link.targetFile) continue;

    if (!fileExportedSymbols.has(link.targetFile)) {
      fileExportedSymbols.set(link.targetFile, new Map());
    }
    const symMap = fileExportedSymbols.get(link.targetFile)!;
    if (!symMap.has(link.targetSymbol)) {
      symMap.set(link.targetSymbol, []);
    }

    const symKey = `${link.targetFile}::${link.targetSymbol}`;
    if (!callerSeen.has(symKey)) callerSeen.set(symKey, new Set());
    const seen = callerSeen.get(symKey)!;
    const siteKey = `${link.sourceFile}::${link.sourceLine}`;
    if (seen.has(siteKey)) continue;
    seen.add(siteKey);

    symMap.get(link.targetSymbol)!.push({
      file: link.sourceFile,
      line: link.sourceLine,
    });
  }

  const results: BlastRadiusInfo[] = [];
  // One walk's visited marks: a file is seen when its slot holds the walk's stamp.
  const seen = new Uint32Array(fileCount);
  const burdenSeen = new Uint32Array(fileCount);
  const queue = new Int32Array(fileCount + 1);
  const depths = new Uint8Array(fileCount + 1);

  for (let id = 0; id < fileCount; id++) {
    const filePath = names[id]!;
    const stamp = id + 1;
    // ── Direct dependents ──
    const directDeps = reverse[id]!;
    const directCount = directDeps.length;
    const affectedFiles = directDeps.map((d) => names[d]!).sort().slice(0, AFFECTED_LIST_CAP);

    // ── Transitive dependents via BFS (max depth 8) ──
    seen[id] = stamp;
    let queued = 0;
    for (const dep of directDeps) {
      seen[dep] = stamp;
      queue[queued] = dep;
      depths[queued++] = 1;
    }

    const transitiveFiles: string[] = [];
    let transitiveCount = 0;
    let impactScore = directCount;
    let maxDepth = directCount > 0 ? 1 : 0;

    let qi = 0;
    while (qi < queued) {
      const depth = depths[qi]!;
      const file = queue[qi++]!;
      if (depth > maxDepth) maxDepth = depth;

      if (depth >= 8) continue;

      for (const next of reverse[file]!) {
        if (seen[next] !== stamp) {
          seen[next] = stamp;
          transitiveCount++;
          if (transitiveFiles.length < TRANSITIVE_LIST_CAP) transitiveFiles.push(names[next]!);
          impactScore += 1 / (depth + 1); // decay with depth
          queue[queued] = next;
          depths[queued++] = depth + 1;
        }
      }
    }
    transitiveFiles.sort();

    // ── Own dependencies (fragility) ──
    const dependsOn = (componentGraph[filePath] ?? []).slice().sort();

    // ── Per-symbol usage ──
    const symMap = fileExportedSymbols.get(filePath);
    const exportedSymbols: BlastSymbolUsage[] = [];
    if (symMap) {
      for (const [name, callers] of symMap) {
        exportedSymbols.push({
          name,
          usedByCount: callers.length,
          callers: callers
            .sort((a, b) => byOrdinal(a.file, b.file) || a.line - b.line)
            .slice(0, CALLERS_LIST_CAP),
        });
      }
      exportedSymbols.sort((a, b) => b.usedByCount - a.usedByCount || byOrdinal(a.name, b.name));
    }

    // ── Centrality ──
    const symbolsUsed = exportedSymbols.reduce((s, sym) => s + sym.usedByCount, 0);
    const centrality = directCount + dependsOn.length + symbolsUsed;

    // ── Level classification ──
    let level: BlastRadiusInfo["level"] = "low";
    if (directCount >= 8 || exportedSymbols.length >= 5) level = "critical";
    else if (directCount >= 4 || exportedSymbols.length >= 3) level = "high";
    else if (directCount >= 2 || exportedSymbols.length >= 1) level = "medium";

    // ── Change risk: accounts for both inbound (dependents) and outbound (dependencies) ──
    // A file that is both heavily depended upon AND depends on many things is most dangerous
    const inboundWeight = directCount + transitiveCount * 0.3;
    const outboundWeight = dependsOn.length;
    const riskScore = inboundWeight * 2 + outboundWeight;
    let changeRisk: BlastRadiusInfo["changeRisk"] = "safe";
    if (riskScore >= 15 || (directCount >= 6 && dependsOn.length >= 3)) {
      changeRisk = "dangerous";
    } else if (riskScore >= 5 || directCount >= 3) {
      changeRisk = "moderate";
    }

    results.push({
      filePath,
      directDependents: directCount,
      transitiveDependents: transitiveCount,
      impactScore: Math.round(impactScore * 10) / 10,
      centrality,
      level,
      affectedFiles,
      transitiveFiles,
      dependsOn,
      exportedSymbols,
      changeRisk,
      maxDepth,
      contextBurden: contextBurdenFor(id, graph, lineCounts, CONTEXT_HOPS, burdenSeen, stamp),
    });
  }

  // Sort by impact score descending; ties by path, so a cold and an incremental
  // run (whose files arrive in different orders) write the same rows in the same order.
  results.sort((a, b) => b.impactScore - a.impactScore || byOrdinal(a.filePath, b.filePath));

  return results;
}
