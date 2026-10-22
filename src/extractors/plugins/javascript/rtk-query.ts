import type { DataSourceInfo, FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { ProjectApiCall } from "../../data-sources/base.js";

/**
 * RTK Query hooks, resolved to the endpoint they call. A component's
 * `useGetPostsQuery()` names only the endpoint (`getPosts`); the API slice the
 * hook is imported from defines it (`data-sources.ts` tags each definition
 * with its `endpoint`). The call takes the definition's method and URL — from
 * the imported slice, else from the one definition of that name in the
 * project. A `use…Query` / `use…Mutation` the project itself declares as a
 * function (a TanStack Query composable, `const useX = () => useQuery(…)`)
 * is no generated hook: its row is dropped, and the calls inside that
 * function are what reaches the API — as is one a package exports
 * (`useRouteQuery`, `useMediaQuery`) or any in a project with no API slice.
 * Returns how many calls it resolved.
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
  const declared = new Map(analyses.map((a) => [a.filePath, a]));
  const ownHooks = new Set<ProjectApiCall>();
  let count = 0;
  for (const c of pending) {
    // The hook (`useGetPostsQuery`) or the api object (`api.endpoints.x.initiate`) is what the file imports.
    const from = ctx.importIndex.localFor(c.filePath, c.name);
    if (from && c.name.startsWith("use") && declared.get(from)?.functions.some((f) => f.name === c.name)) {
      ownHooks.add(c);
      continue;
    }
    const named = byName.get(c.endpoint!);
    const def = (from ? byFile.get(from)?.get(c.endpoint!) : undefined) ?? (named?.length === 1 ? named[0] : undefined);
    if (!def) {
      // A `use…Query` from a package (`useRouteQuery`, `useMediaQuery`), or in a project
      // that defines no API slice at all, is no generated hook.
      const source = from ? null : ctx.importIndex.sourceFor(c.filePath, c.name);
      const fromPackage = !!source && !/^[.~#/]|^@\//.test(source);
      if (c.name.startsWith("use") && (fromPackage || byName.size === 0)) ownHooks.add(c);
      continue;
    }
    c.target = def.target;
    if (def.targetAlternatives) c.targetAlternatives = def.targetAlternatives;
    c.name = def.name;
    count++;
  }
  if (ownHooks.size > 0) {
    let w = 0;
    for (const c of calls) if (!ownHooks.has(c)) calls[w++] = c;
    calls.length = w;
  }
  return count;
}
