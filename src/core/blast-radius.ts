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
 * The files an editor must hold in mind to change `start` safely: everything
 * within `hops` hops following imports in BOTH directions. Downstream files
 * break when the contract changes; upstream files define the contracts being
 * relied on. Self is excluded from the count but included in the size.
 */
function contextBurdenFor(
  start: string,
  forward: Record<string, string[]>,
  reverse: Map<string, Set<string>>,
  lineCounts: ReadonlyMap<string, number> | undefined,
  hops: number,
): ContextBurden {
  const visited = new Set<string>([start]);
  let frontier = [start];
  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const n of forward[node] ?? []) if (!visited.has(n)) { visited.add(n); next.push(n); }
      for (const n of reverse.get(node) ?? []) if (!visited.has(n)) { visited.add(n); next.push(n); }
    }
    frontier = next;
  }
  let lines: number | null = null;
  if (lineCounts) {
    for (const f of visited) {
      const n = lineCounts.get(f);
      if (n !== undefined) lines = (lines ?? 0) + n;
    }
  }
  return {
    files: visited.size - 1,
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
  // ── Build reverse graph: file → files that depend on it ──
  const reverseGraph = new Map<string, Set<string>>();

  for (const [source, targets] of Object.entries(componentGraph)) {
    for (const target of targets) {
      if (!reverseGraph.has(target)) reverseGraph.set(target, new Set());
      reverseGraph.get(target)!.add(source);
    }
  }

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

  // ── Collect all files that appear in the graph ──
  const allFiles = new Set<string>();
  for (const [source, targets] of Object.entries(componentGraph)) {
    allFiles.add(source);
    for (const t of targets) allFiles.add(t);
  }

  const results: BlastRadiusInfo[] = [];

  for (const filePath of allFiles) {
    // ── Direct dependents ──
    const directDeps = reverseGraph.get(filePath) ?? new Set();
    const directCount = directDeps.size;
    const affectedFiles = [...directDeps].sort().slice(0, AFFECTED_LIST_CAP);

    // ── Transitive dependents via BFS (max depth 8) ──
    const visited = new Set<string>([filePath, ...directDeps]);
    const queue: { file: string; depth: number }[] = [];
    for (const dep of directDeps) {
      queue.push({ file: dep, depth: 1 });
    }

    const transitiveFiles: string[] = [];
    let transitiveCount = 0;
    let impactScore = directCount;
    let maxDepth = directCount > 0 ? 1 : 0;

    let qi = 0;
    while (qi < queue.length) {
      const { file, depth } = queue[qi++];
      if (depth > maxDepth) maxDepth = depth;

      if (depth >= 8) continue;

      const nextDeps = reverseGraph.get(file) ?? new Set();
      for (const next of nextDeps) {
        if (!visited.has(next)) {
          visited.add(next);
          transitiveCount++;
          if (transitiveFiles.length < TRANSITIVE_LIST_CAP) transitiveFiles.push(next);
          impactScore += 1 / (depth + 1); // decay with depth
          queue.push({ file: next, depth: depth + 1 });
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
      contextBurden: contextBurdenFor(filePath, componentGraph, reverseGraph, options.lineCounts, CONTEXT_HOPS),
    });
  }

  // Sort by impact score descending; ties by path, so a cold and an incremental
  // run (whose files arrive in different orders) write the same rows in the same order.
  results.sort((a, b) => b.impactScore - a.impactScore || byOrdinal(a.filePath, b.filePath));

  return results;
}
