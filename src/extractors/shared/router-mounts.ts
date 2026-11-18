import type { FileAnalysis, RouteInfo } from "../../types/analysis.js";
import type { ImportIndex } from "../../types/project.js";
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
 * distinct endpoints into one. Against hand labels, route-path F1 measured
 * 0.000 with declaration-site F1 at 0.848, which is exactly that shape: the
 * declarations were found, the paths were wrong, and the collisions ate the
 * rest.
 *
 * A mount is an api route marked `mount: true` whose `handler` is the router
 * identifier — what the Express extractor emits for `app.use(prefix, routerVar)`
 * and the Python extractor for `include_router(mod.router, prefix=…)`. The
 * marker is explicit because the shape alone (null method, identifier handler)
 * is also an "any method" endpoint — Compojure `ANY "/x" handler` — which must
 * never be swallowed as wiring. This project-level pass resolves that
 * identifier through the import index to the router's file, then prefixes every
 * API route declared there. Mounts compose transitively (`server.js` → `apiRouter`
 * → `authRouter`, or `api.py` → `articles/api.py` → `articles_resource.py`), and
 * a router mounted at several prefixes yields one route per prefix.
 *
 * Mount-level middleware reach propagates too: `middlewareCalls` on a mount row
 * and `inheritedMiddleware` a resolver stamped on the mount (e.g. FastAPI router
 * class dependencies before `include_router`) merge onto every route of the
 * mounted file, with mount `middlewareCalls` resolved in the mounting file.
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

/** A mount site along the chain that contributes guards or middleware reach. */
interface MountGuard {
  mountingFile: string;
  route: RouteInfo;
}

function pushInheritedMiddleware(
  inherited: Array<{ file: string; calls: string[] }>,
  file: string,
  calls: string[],
): void {
  const uniq = [...new Set(calls)];
  if (uniq.length === 0) return;
  const row = inherited.find((e) => e.file === file);
  if (row) row.calls = [...new Set([...row.calls, ...uniq])];
  else inherited.push({ file, calls: uniq });
}

export function resolveRouterMounts(analyses: FileAnalysis[], importIndex: ImportIndex): number {
  // A mount target must be a router — i.e. a file that declares ≥1 API route.
  const apiRouteFiles = new Set<string>();
  for (const a of analyses) {
    if ((a.routes ?? []).some((r) => r.kind === "api")) apiRouteFiles.add(a.filePath);
  }

  // 1. Collect direct mounts: a mount row whose handler is a bare identifier
  //    resolving — through the importing file's imports — to a known router file.
  const mountsByTarget = new Map<string, Mount[]>();
  const dropped = new Set<RouteInfo>();
  for (const a of analyses) {
    for (const r of a.routes ?? []) {
      if (!r.mount || r.kind !== "api") continue;
      // A router loaded where it is mounted (`register(require("./clubs"), …)`) names its module, not a binding.
      const target = r.mountModule
        ? importIndex.fileForSource?.(a.filePath, r.mountModule) ?? null
        : r.handler && BARE_IDENT.test(r.handler) ? importIndex.localFor(a.filePath, r.handler) : null;
      if (!target || target === a.filePath || !apiRouteFiles.has(target)) continue;
      (mountsByTarget.get(target) ?? mountsByTarget.set(target, []).get(target)!).push({
        mountingFile: a.filePath,
        prefix: r.path,
        route: r,
      });
      dropped.add(r);
    }
  }
  // A mount that resolves to no router and adds no prefix says nothing: drop it
  // rather than leave an empty, method-less non-endpoint in the route map.
  // (A non-empty unresolved one stays — `app.use("/static", serveStatic)` is a
  // real path.)
  for (const a of analyses) {
    if ((a.routes ?? []).some((r) => r.mount && !dropped.has(r) && !r.path)) {
      a.routes = a.routes.filter((r) => !(r.mount && !dropped.has(r) && !r.path));
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

  // 2b. Guards and middleware reach declared on the mount
  //     (`app.use('/admin', requireAuth, adminRouter)`, FastAPI
  //     `include_router(child, dependencies=[…])`, or `inheritedMiddleware` on
  //     a mount row) apply to every route of the mounted router. Collected along
  //     the whole mount chain; `middlewareCalls` on a mount resolve in the
  //     mounting file.
  const mountContributes = (route: RouteInfo) =>
    route.middleware.length > 0 ||
    !!route.auth ||
    (route.inheritedMiddleware?.length ?? 0) > 0 ||
    (route.middlewareCalls?.length ?? 0) > 0;
  const guardMemo = new Map<string, MountGuard[]>();
  const guardStack = new Set<string>();
  const mountGuards = (file: string): MountGuard[] => {
    const cached = guardMemo.get(file);
    if (cached) return cached;
    const incoming = mountsByTarget.get(file);
    if (!incoming || guardStack.has(file)) return [];
    guardStack.add(file);
    const out: MountGuard[] = [];
    for (const m of incoming) {
      out.push(...mountGuards(m.mountingFile));
      if (mountContributes(m.route)) out.push({ mountingFile: m.mountingFile, route: m.route });
    }
    guardStack.delete(file);
    guardMemo.set(file, out);
    return out;
  };
  const inheritGuards = (r: RouteInfo, mounts: MountGuard[]): RouteInfo => {
    if (mounts.length === 0) return r;
    const middleware = [...mounts.flatMap((m) => m.route.middleware), ...r.middleware];
    const inheritedMiddleware = [...(r.inheritedMiddleware ?? [])];
    for (const m of mounts) {
      for (const entry of m.route.inheritedMiddleware ?? []) pushInheritedMiddleware(inheritedMiddleware, entry.file, entry.calls);
      if (m.route.middlewareCalls?.length) pushInheritedMiddleware(inheritedMiddleware, m.mountingFile, m.route.middlewareCalls);
    }
    const auths = mounts.map((m) => m.route.auth).filter((a): a is NonNullable<typeof a> => !!a);
    const uniq = (xs: string[]) => [...new Set(xs)];
    const own = r.auth;
    const base: RouteInfo = {
      ...r,
      middleware,
      ...(inheritedMiddleware.length > 0 ? { inheritedMiddleware } : {}),
    };
    if (auths.length === 0) return base;
    return {
      ...base,
      auth: {
        policies: uniq([...auths.flatMap((a) => a.policies), ...(own?.policies ?? [])]),
        roles: uniq([...auths.flatMap((a) => a.roles), ...(own?.roles ?? [])]),
        schemes: uniq([...auths.flatMap((a) => a.schemes), ...(own?.schemes ?? [])]),
        anonymous: own?.anonymous ?? false,
        inherited: own ? own.inherited : true,
      },
    };
  };

  // 3. Apply: prefix each mounted router's own API routes; drop mount routes.
  let prefixed = 0;
  for (const a of analyses) {
    const routes = a.routes ?? [];
    if (routes.length === 0) continue;
    const prefixes = effective(a.filePath);
    const isMounted = !(prefixes.length === 1 && prefixes[0] === "");
    if (!isMounted && !routes.some((r) => dropped.has(r))) continue;
    const guards = isMounted ? mountGuards(a.filePath) : [];

    const next: RouteInfo[] = [];
    for (const r of routes) {
      if (dropped.has(r)) continue; // resolved router mount — not an endpoint
      if (isMounted && r.kind === "api") {
        const guarded = inheritGuards(r, guards);
        for (const p of prefixes) {
          next.push(p === "" ? guarded : { ...guarded, path: joinRoutePath(p, r.path) });
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
