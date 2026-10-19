import type { FileAnalysis, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { joinRoutePath } from "../../../shared/route-paths.js";

/** `rel` under `prefix`, anchored: under "/" a relative path becomes absolute (`joinRoutePath` keeps it relative). */
function under(prefix: string, rel: string): string {
  return prefix === "/" || prefix === "" ? `/${rel.replace(/^\/+/, "")}` : joinRoutePath(prefix, rel);
}
import type { RouteArrayFact, RouteMapFact } from "./react-router.js";

/**
 * What a frontend router declares across files, which one file cannot see:
 *
 *  - a path named by an imported constant (`path={paths.orders}`, written as
 *    a `${paths.orders}` hole per file) takes the value the module that
 *    exports it holds (`FileAnalysis.moduleValues`); a hole nothing fills is
 *    dropped — it is not a path anyone requests;
 *  - `appRoutes.map((r) => <Route path={r.path} element={<r.view />} />)`
 *    renders one route per element of an array, here or imported: each lands
 *    at the element's own file and line, with the page the mapped property
 *    names;
 *  - `<Route path="/admin/*" element={<AdminRoutes />} />` (or `/admin`) mounts the
 *    descendant `<Routes>` AdminRoutes renders: their relative paths sit
 *    under `/admin`, and its "/" (an index route) is `/admin` itself.
 *
 * Names are followed through the import index only — never project-wide.
 */
export const reactRouterResolver: RouteResolver = {
  id: "react-router",
  languages: ["typescript", "javascript"],
  priority: 50,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const byFile = new Map(analyses.map((a) => [a.filePath, a]));
    const sourceOf = (file: string, local: string): string => ctx.importIndex.localFor(file, local) ?? file;

    // A `${a.b}` hole: the value module `a` came from holds under `a.b` (or,
    // through a namespace import `* as a`, under `b`).
    const fill = (path: string, file: string): string | null => {
      if (!path.includes("${")) return path;
      let ok = true;
      const out = path.replace(/\$\{([A-Za-z_$][\w$]*)((?:\.[\w$]+)*)\}/g, (hole, head: string, rest: string) => {
        const source = sourceOf(file, head);
        const values = byFile.get(source)?.moduleValues ?? {};
        const v = values[head + rest] ?? (source !== file && rest ? values[rest.slice(1)] : undefined);
        if (v === undefined || v.includes("${")) ok = false;
        return v ?? hole;
      });
      return ok ? out : null;
    };

    for (const a of analyses) {
      if (!a.routes.some((r) => r.kind === "frontend" && r.path.includes("${"))) continue;
      a.routes = a.routes.flatMap((r) => {
        if (r.kind !== "frontend" || !r.path.includes("${")) return [r];
        const path = fill(r.path, a.filePath);
        return path === null ? [] : [{ ...r, path }];
      });
    }

    // An array's elements with the file each is declared in, through the
    // arrays it spreads (`[...partnerRoutes]`, imported or local).
    const arrayItems = (file: string, name: string, depth = 0): Array<{ target: FileAnalysis; item: RouteArrayFact["items"][number] }> => {
      const target = byFile.get(sourceOf(file, name));
      const array = target?.routeFacts?.find((x) => x.kind === "react-router-array" && (x.data as RouteArrayFact).name === name)?.data as RouteArrayFact | undefined;
      if (!target || !array) return [];
      const own = array.items.map((item) => ({ target, item }));
      return depth >= 4 ? own : [...own, ...(array.spreads ?? []).flatMap((s) => arrayItems(target.filePath, s, depth + 1))];
    };

    // Mapped arrays → one route per element, at the element.
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== "react-router-map") continue;
        const m = f.data as RouteMapFact;
        if (m.pathProp !== "path") continue;
        for (const { target, item } of arrayItems(a.filePath, m.array)) {
          const own = fill(item.path, target.filePath);
          if (own === null) continue;
          const headed = m.head + own;
          const path = m.prefix && !headed.startsWith("/") ? under(m.prefix, headed) : headed;
          const page = m.componentProp ? item.props[m.componentProp] : undefined;
          // The element may be a route already (`{ path, component }`): re-place it.
          const at = target.routes.findIndex((r) => r.kind === "frontend" && r.line === item.line);
          if (at >= 0) {
            const was = target.routes[at]!;
            if (was.path === path && (!page || was.handler)) continue;
            target.routes = target.routes.map((r, i) =>
              i === at ? { ...was, path, ...(page && !was.handler ? { handler: page.name, componentPath: page.specifier } : {}) } : r,
            );
            continue;
          }
          target.routes = [
            ...target.routes,
            { path, httpMethod: null, kind: "frontend", handler: page?.name ?? null, componentPath: page?.specifier ?? null, calls: [], middleware: [], line: item.line },
          ];
        }
      }
    }

    // Descendant <Routes> under a mount (`/admin/*`, or `/admin` rendering a
    // component whose file declares relative routes). A mount whose own path
    // is still relative waits a round for its parent to compose it.
    const mounted = new Set<RouteInfo>();
    for (let round = 0; round < 4; round++) {
      let changed = false;
      for (const a of analyses) {
        for (const r of a.routes) {
          if (r.kind !== "frontend" || !r.path.startsWith("/") || !r.componentPath || !/^[A-Z][\w$]*$/.test(r.componentPath)) continue;
          const file = ctx.importIndex.localFor(a.filePath, r.componentPath);
          const t = file && file !== a.filePath ? byFile.get(file) : undefined;
          if (!t) continue;
          const base = r.path.replace(/\/\*$/, "") || "/";
          t.routes = t.routes.map((d) => {
            // In a mounted file "/" is the mount's own root (an index route
            // with nothing above it in this file); other absolute paths stand.
            if (d.kind !== "frontend" || mounted.has(d) || d.path === "*" || (d.path.startsWith("/") && d.path !== "/")) return d;
            const row = { ...d, path: d.path === "/" ? base : under(base, d.path) };
            mounted.add(row);
            changed = true;
            return row;
          });
        }
      }
      if (!changed) break;
    }
  },
};
