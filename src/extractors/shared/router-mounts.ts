import type { FileAnalysis, RouteInfo } from "../../types/analysis.js";
import type { ImportIndex } from "../../core/import-index.js";
import { joinRoutePath } from "./route-paths.js";

/**
 * Apply router MOUNT PREFIXES so each route carries the path a caller requests.
 *
 * Frameworks that split routes across modules declare the prefix in a *different
 * file* from the endpoints. Express wires it with `app.use("/api/auth", authRoutes)`
 * in `server.js`; FastAPI with `router.include_router(auth.router, prefix="/users")`
 * in `api.py`. Either way the per-file route extractor sees only the bare
 * router-level path (`router.get("/profile", …)` → `/profile`, `@router.get("")`
 * → `""`) and never the prefix. Without this pass the route map shows `/profile`
 * instead of `/api/auth/profile`, and the cross-tier screen→API join cannot
 * match a frontend call against it.
 *
 * On FastAPI it is worse than a cosmetic truncation: several routers each
 * declare `@router.get("")`, so once the prefix is gone they are all literally
 * `GET ""` and `dedupeRoutes` — which keys on method+path — collapses five
 * distinct endpoints into one. The accuracy eval measured route-path F1 at
 * 0.000 with declaration-site F1 at 0.848, which is exactly that shape: the
 * declarations were found, the paths were wrong, and the collisions ate the
 * rest.
 *
 * A mount is represented as an api route with `httpMethod: null` whose `handler`
 * is the router identifier — the shape the Express extractor already emitted for
 * `app.use(prefix, routerVar)`, and which the Python extractor now emits for
 * `include_router(mod.router, prefix=…)`. This project-level pass resolves that
 * identifier through the import index to the router's file, then prefixes every
 * API route declared there. Mounts compose transitively (`server.js` → `apiRouter`
 * → `authRouter`, or `api.py` → `articles/api.py` → `articles_resource.py`), and
 * a router mounted at several prefixes yields one route per prefix.
 *
 * The resolved mount routes themselves are dropped — they are wiring, not
 * endpoints, so leaving them would inflate the route map with non-routes.
 *
 * Language-agnostic by construction: it reads only `FileAnalysis.routes` and the
 * import index, so any extractor that emits mounts in this shape participates.
 * The analyzer invokes it once after per-file analysis, mirroring how
 * `reconcileProjectEntities` runs each entity plugin's cross-file pass. In-memory
 * only — the per-file JSON on disk is unchanged.
 *
 * Returns the number of routes that received a prefix. Mutates `analyses`.
 */

const BARE_IDENT = /^[A-Za-z_$][\w$]*$/;

interface Mount {
  mountingFile: string;
  prefix: string;
  route: RouteInfo;
}

export function resolveRouterMounts(analyses: FileAnalysis[], importIndex: ImportIndex): number {
  // A mount target must be a router — i.e. a file that declares ≥1 API route.
  const apiRouteFiles = new Set<string>();
  for (const a of analyses) {
    if ((a.routes ?? []).some((r) => r.kind === "api")) apiRouteFiles.add(a.filePath);
  }

  // 1. Collect direct mounts: a `use` route (httpMethod null) whose handler is a
  //    bare identifier resolving — through the importing file's imports — to a
  //    known router file.
  const mountsByTarget = new Map<string, Mount[]>();
  const dropped = new Set<RouteInfo>();
  for (const a of analyses) {
    for (const r of a.routes ?? []) {
      if (r.kind !== "api" || r.httpMethod !== null) continue;
      if (!r.handler || !BARE_IDENT.test(r.handler)) continue;
      const target = importIndex.localFor(a.filePath, r.handler);
      if (!target || target === a.filePath || !apiRouteFiles.has(target)) continue;
      (mountsByTarget.get(target) ?? mountsByTarget.set(target, []).get(target)!).push({
        mountingFile: a.filePath,
        prefix: r.path,
        route: r,
      });
      dropped.add(r);
    }
  }
  if (mountsByTarget.size === 0) return 0;

  // 2. Effective prefix(es) per file. A mounting file may itself be mounted
  //    (`server.js` → `apiRouter` → `authRouter`), so the effective prefix of a
  //    target is its mounting file's effective prefix joined with the mount path.
  //    A file mounted nowhere has the empty prefix (it's at the app root).
  const memo = new Map<string, string[]>();
  const onStack = new Set<string>();
  const effective = (file: string): string[] => {
    const cached = memo.get(file);
    if (cached) return cached;
    const incoming = mountsByTarget.get(file);
    if (!incoming || onStack.has(file)) return [""]; // unmounted, or a mount cycle
    onStack.add(file);
    const out: string[] = [];
    for (const m of incoming) {
      for (const base of effective(m.mountingFile)) out.push(joinRoutePath(base, m.prefix));
    }
    onStack.delete(file);
    const result = out.length ? [...new Set(out)] : [""];
    memo.set(file, result);
    return result;
  };

  // 3. Apply: prefix each mounted router's own API routes; drop mount routes.
  let prefixed = 0;
  for (const a of analyses) {
    const routes = a.routes ?? [];
    if (routes.length === 0) continue;
    const prefixes = effective(a.filePath);
    const isMounted = !(prefixes.length === 1 && prefixes[0] === "");
    if (!isMounted && !routes.some((r) => dropped.has(r))) continue;

    const next: RouteInfo[] = [];
    for (const r of routes) {
      if (dropped.has(r)) continue; // resolved router mount — not an endpoint
      if (isMounted && r.kind === "api") {
        for (const p of prefixes) {
          next.push(p === "" ? r : { ...r, path: joinRoutePath(p, r.path) });
          if (p !== "") prefixed++;
        }
      } else {
        next.push(r);
      }
    }
    a.routes = next;
  }
  return prefixed;
}
