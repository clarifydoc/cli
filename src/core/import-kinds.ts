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

/** The import graph without its type-only edges. */
export function runtimeGraph(graph: Readonly<Record<string, readonly string[]>>, typeOnly: Readonly<Record<string, readonly string[]>> | undefined): Record<string, string[]> {
  if (!typeOnly || Object.keys(typeOnly).length === 0) return graph as Record<string, string[]>;
  const out: Record<string, string[]> = {};
  for (const [from, tos] of Object.entries(graph)) {
    const drop = typeOnly[from];
    out[from] = drop ? tos.filter((t) => !drop.includes(t)) : [...tos];
  }
  return out;
}
