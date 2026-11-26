import type { FileAnalysis } from "../types/analysis.js";
import type { ProjectPass, ProjectPassContext } from "../types/language-plugin.js";
import { allPluginMetas } from "./registry.js";

/**
 * Run every plugin's `projectPasses` once (a family's metas share one array),
 * in registry order and each plugin's own order, after per-file analysis and
 * before the import index and the linker. Core names no framework; each pass
 * decides what it reads and adds. Returns each pass's label and count.
 *
 * A pass is async, reads what it needs from disk and adds to the analyses in memory only: routes a build plugin
 * generates from a page folder (unplugin-vue-router, vite-plugin-pages), a component's `templateUrl` template. The
 * count is what `analyze --verbose` prints under the pass's `label`.
 */
export async function runProjectPasses(analyses: FileAnalysis[], ctx: ProjectPassContext): Promise<Array<{ label: string; count: number }>> {
  const seen = new Set<ProjectPass>();
  const out: Array<{ label: string; count: number }> = [];
  for (const meta of allPluginMetas()) {
    for (const pass of meta.projectPasses ?? []) {
      if (seen.has(pass)) continue;
      seen.add(pass);
      out.push({ label: pass.label, count: await pass.run(analyses, ctx) });
    }
  }
  return out;
}
