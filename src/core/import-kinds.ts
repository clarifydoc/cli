import type { SymbolLink } from "../types/analysis.js";

/**
 * Edges of the import graph that carry no runtime dependency: every import
 * stating them is type-only (`import type { X }`), and no call goes along
 * them. A cycle through such an edge is no cycle at runtime — nothing
 * initializes in the wrong order, nothing can deadlock on module load — so
 * cycles are judged on the graph without them, and the type-only ones are
 * shown apart.
 */
export function typeOnlyEdges(fromImports: Readonly<Record<string, readonly string[]>>, links: readonly SymbolLink[]): Record<string, string[]> {
  const called = new Set<string>();
  for (const l of links) {
    if (l.navigational || l.relation === "reference" || l.sourceSymbol.startsWith("(")) continue;
    if (l.sourceFile !== l.targetFile) called.add(`${l.sourceFile}\u0000${l.targetFile}`);
  }
  const out: Record<string, string[]> = {};
  for (const [from, tos] of Object.entries(fromImports)) {
    const kept = tos.filter((to) => !called.has(`${from}\u0000${to}`));
    if (kept.length) out[from] = [...kept].sort();
  }
  return out;
}

type EdgeMap = Readonly<Record<string, readonly string[]>>;

/**
 * The import graph a cycle is judged on: without its type-only edges and
 * without the edges only a dynamic `import()` states — a module loaded on
 * demand is not loaded with its importer, so nothing in such a cycle
 * initializes in the wrong order (`ProjectAnalysis.dynamicImportEdges`).
 */
export function runtimeGraph(graph: EdgeMap, typeOnly: EdgeMap | undefined, dynamic?: EdgeMap): Record<string, string[]> {
  const drops = [typeOnly, dynamic].filter((d): d is EdgeMap => !!d && Object.keys(d).length > 0);
  if (drops.length === 0) return graph as Record<string, string[]>;
  const out: Record<string, string[]> = {};
  for (const [from, tos] of Object.entries(graph)) {
    const drop = drops.flatMap((d) => d[from] ?? []);
    out[from] = drop.length ? tos.filter((t) => !drop.includes(t)) : [...tos];
  }
  return out;
}
