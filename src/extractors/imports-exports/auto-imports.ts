import type { FileAnalysis } from "../../types/analysis.js";
import { allPluginMetas } from "../registry.js";

/**
 * Run every plugin's `autoImports` pass once (a family's metas share one):
 * names a framework puts in scope without an import line become the imports
 * the files would have written, before the import index and the linker see
 * them. Core names no framework; the plugin decides what is auto-imported.
 */
export function applyAutoImports(analyses: FileAnalysis[]): number {
  const seen = new Set<(analyses: FileAnalysis[]) => number>();
  let added = 0;
  for (const meta of allPluginMetas()) {
    const pass = meta.autoImports;
    if (!pass || seen.has(pass)) continue;
    seen.add(pass);
    added += pass(analyses);
  }
  return added;
}
