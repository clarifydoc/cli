import type { DataSourceInfo, FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { ProjectApiCall } from "../../data-sources/base.js";

/**
 * RTK Query hooks, resolved to the endpoint they call. A component's
 * `useGetPostsQuery()` names only the endpoint (`getPosts`); the API slice the
 * hook is imported from defines it (`data-sources.ts` tags each definition
 * with its `endpoint`). The call takes the definition's method and URL — from
 * the imported slice, else from the one definition of that name in the
 * project. Returns how many calls it resolved.
 */
export function resolveRtkHooks(calls: ProjectApiCall[], analyses: readonly FileAnalysis[], ctx: ProjectContext): number {
  const pending = calls.filter((c) => c.kind === "api-call" && c.endpoint && c.target === null);
  if (pending.length === 0) return 0;
  const byFile = new Map<string, Map<string, DataSourceInfo>>();
  const byName = new Map<string, DataSourceInfo[]>();
  for (const a of analyses) {
    for (const ds of a.dataSources) {
      if (ds.kind !== "api-call" || !ds.endpoint || !ds.target) continue;
      (byFile.get(a.filePath) ?? byFile.set(a.filePath, new Map()).get(a.filePath)!).set(ds.endpoint, ds);
      (byName.get(ds.endpoint) ?? byName.set(ds.endpoint, []).get(ds.endpoint)!).push(ds);
    }
  }
  let count = 0;
  for (const c of pending) {
    // The hook (`useGetPostsQuery`) or the api object (`api.endpoints.x.initiate`) is what the file imports.
    const from = ctx.importIndex.localFor(c.filePath, c.name);
    const named = byName.get(c.endpoint!);
    const def = (from ? byFile.get(from)?.get(c.endpoint!) : undefined) ?? (named?.length === 1 ? named[0] : undefined);
    if (!def) continue;
    c.target = def.target;
    c.name = def.name;
    count++;
  }
  return count;
}
