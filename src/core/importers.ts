import type { ProjectAnalysis } from "../types/analysis.js";

/** Importee → the files importing it: `componentGraph` turned around, for walks from a file to its dependents. */
export function importersOf(componentGraph: ProjectAnalysis["componentGraph"] | undefined): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const [from, tos] of Object.entries(componentGraph ?? {})) for (const to of tos) (importers.get(to) ?? importers.set(to, []).get(to)!).push(from);
  return importers;
}
