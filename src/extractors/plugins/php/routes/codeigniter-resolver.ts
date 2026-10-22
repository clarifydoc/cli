import type { FileAnalysis, RouteInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { CI_ROUTE_FACT, LARAVEL_ROUTES_FACT, controllerBase, type CiRouteAlias } from "./codeigniter.js";

/**
 * `config/routes.php` aliases onto the convention routes they name:
 *
 *   $route['clubs'] = 'club/list';                → `/club/list` answers `/clubs`
 *   $route['clubs/(:num)'] = 'club/view/$1';      → `/club/view` answers `/clubs/{p1}`
 *   $route['league/(:any)'] = 'league/index/$1';  → `/league` answers `/league/{p1}`
 *
 * The target is the controller method the URI names once its `$n`
 * back-references are dropped; a bare controller is its `index`. Wildcards
 * and regex groups in the alias are runtime segments. An entry naming no
 * method of the sub-project's controllers aliases nothing.
 *
 * A sub-project that declares Laravel `Route::` routes routes by them alone:
 * the convention rows of its `…/Controllers/` folders (`app/Api/V1/Controllers/`)
 * are dropped.
 */
export const codeigniterRoutesResolver: RouteResolver = {
  id: "codeigniter-routes",
  languages: ["php"],
  priority: 40,
  resolve(analyses: FileAnalysis[]): void {
    const aliases = new Map<string, CiRouteAlias[]>();
    const laravel = new Set<string>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === LARAVEL_ROUTES_FACT) laravel.add(a.projectId ?? "");
        if (f.kind !== CI_ROUTE_FACT) continue;
        const key = a.projectId ?? "";
        (aliases.get(key) ?? aliases.set(key, []).get(key)!).push(f.data as CiRouteAlias);
      }
    }
    if (laravel.size > 0) {
      for (const a of analyses) {
        if (!laravel.has(a.projectId ?? "") || !controllerBase(a.filePath)) continue;
        const kept = a.routes.filter((r) => r.httpMethod !== null || r.kind !== "api");
        if (kept.length !== a.routes.length) a.routes = kept;
      }
    }
    if (aliases.size === 0) return;

    for (const [project, entries] of aliases) {
      const byPath = new Map<string, { a: FileAnalysis; r: RouteInfo }>();
      for (const a of analyses) {
        if ((a.projectId ?? "") !== project || !controllerBase(a.filePath)) continue;
        for (const r of a.routes) if (r.kind === "api") byPath.set(r.path.toLowerCase(), { a, r });
      }
      const added = new Map<RouteInfo, string[]>();
      for (const e of entries) {
        const target = "/" + e.to.split("/").filter((s) => s && !/^\$\d+$/.test(s)).join("/").toLowerCase();
        const hit = byPath.get(target) ?? byPath.get(target.replace(/\/index$/, ""));
        if (!hit) continue;
        let n = 0;
        const from = "/" + e.from.replace(/^\/|\/$/g, "").split("/").map((s) => (/^\(.*\)$|[()[\]*+?\\]/.test(s) ? `{p${++n}}` : s)).join("/");
        if (from === hit.r.path) continue;
        const list = added.get(hit.r) ?? added.set(hit.r, []).get(hit.r)!;
        if (!list.includes(from)) list.push(from);
      }
      for (const a of analyses) {
        if (!a.routes.some((r) => added.has(r))) continue;
        // Replaced, never mutated: the runner stamps `resolvedBy` on new row objects.
        a.routes = a.routes.map((r) => (added.has(r) ? { ...r, aliases: [...new Set([...(r.aliases ?? []), ...added.get(r)!])] } : r));
      }
    }
  },
};
