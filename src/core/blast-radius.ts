import type { BlastRadiusInfo, BlastSymbolUsage, SymbolLink } from "../types/analysis.js";

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

export function analyzeBlastRadius(
  componentGraph: Record<string, string[]>,
  symbolLinks: SymbolLink[],
  totalFiles: number,
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
  // "(reference)" sourceSymbol. They're correctly distinct at the graph layer
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
            .sort((a, b) => a.file.localeCompare(b.file))
            .slice(0, CALLERS_LIST_CAP),
        });
      }
      exportedSymbols.sort((a, b) => b.usedByCount - a.usedByCount);
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
    });
  }

  // Sort by impact score descending
  results.sort((a, b) => b.impactScore - a.impactScore);

  return results;
}
