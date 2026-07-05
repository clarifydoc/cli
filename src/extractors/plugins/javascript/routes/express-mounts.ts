import type { FileAnalysis, RouteInfo } from "../../../../types/analysis.js";
import type { ImportIndex } from "../../../../core/import-index.js";

/**
 * Apply Express router MOUNT PREFIXES so each route carries its full path.
 *
 * Express (the most common Node backend) splits routes across router modules
 * and wires them up in the entry file with `app.use("/api/auth", authRoutes)`.
 * The per-file route extractor only sees the bare router-level path
 * (`router.get("/profile", …)` → `/profile`) and never the mount prefix — which
 * lives in a *different* file (`server.js`) and references the router by an
 * imported identifier. So the route map shows `/profile` instead of the real
 * `/api/auth/profile`, and the cross-tier screen→API join can't match a frontend
 * call to `/api/auth/profile` against it.
 *
 * The mount itself is already captured: `app.use(prefix, routerVar)` is emitted
 * by the express extractor as a `use` route (`httpMethod: null`) whose `handler`
 * is the router identifier. This project-level pass resolves that identifier
 * through the import index to the router's file, then prefixes every API route
 * declared in that file. Mounts compose transitively (a mounted router can
 * `router.use("/sub", child)`), and a router mounted at several prefixes yields
 * one route per prefix.
 *
 * The resolved mount routes themselves are dropped — they are router wiring, not
 * endpoints, so leaving them would inflate the route map with non-routes.
 *
 * This is the JS/Express ecosystem's project-level route step — it lives in the
 * JS route plugin (alongside the express/vue-router extractors and the
 * file-based-routes pass) and is invoked once by the analyzer after per-file
 * analysis, mirroring how `reconcileProjectEntities` runs each entity plugin's
 * cross-file pass. In-memory only — the per-file JSON on disk is unchanged.
 *
 * Returns the number of routes that received a prefix. Mutates `analyses`.
 */

const BARE_IDENT = /^[A-Za-z_$][\w$]*$/;

interface Mount {
  mountingFile: string;
  prefix: string;
  route: RouteInfo;
}

export function resolveExpressMounts(analyses: FileAnalysis[], importIndex: ImportIndex): number {
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

/** Join a mount prefix and a route path into one normalized path (`/api` + `/x` → `/api/x`). */
function joinRoutePath(prefix: string, path: string): string {
  const head = prefix.replace(/\/+$/, "");
  const tail = path === "/" ? "" : path;
  if (!head) return tail || "/";
  const joined = tail === "" || tail.startsWith("/") ? head + tail : `${head}/${tail}`;
  return joined.replace(/\/{2,}/g, "/") || "/";
}
