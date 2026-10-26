import type { FileAnalysis } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import type { ProjectContext } from "../../../types/project.js";
import { ROUTER_CALL, joinRoutePrefix, resolveRouterFunctions, type RouterCall } from "../shared/router-functions.js";
import { ROUTER_VAR, type RouterVar } from "./routes.js";

/**
 * Go routes registered by a function on the router it is handed.
 *
 *   // main.go
 *   v1 := r.Group("/api")
 *   v1.Use(AuthMiddleware())
 *   users.Register(v1.Group("/users"))
 *
 *   // users/routers.go
 *   func Register(router *gin.RouterGroup) { router.POST("/login", Login) }   → POST /api/users/login
 *
 * Composed by the shared kit (`plugins/shared/router-functions.ts`). Go's
 * rule for which function a callee names: a qualified callee
 * (`users.Register`) is the function of that name in the package its import
 * names (the directory the import path ends with); a bare one, in the
 * caller's own package; a method on a value (`h.Register(api)`, whose
 * package is not stated) the one method of that name (`Handler.Register`),
 * else the one function of that name outside the caller's package — or, of several,
 * the one whose package shares the most leading directories with the
 * caller's, when exactly one shares the most and that is at least one
 * (`services/billing/main.go` → `services/billing/handlers`).
 */

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const isMethod = (key: string): boolean => key.slice(key.indexOf("#") + 1).includes(".");

function targetOf(callee: string, caller: FileAnalysis, keysNamed: (fn: string) => string[]): string | null {
  const parts = callee.split(".");
  const fn = parts.pop()!;
  const all = keysNamed(fn);
  if (all.length === 0) return null;
  const own = `${dirOf(caller.filePath)}#${fn}`;
  if (parts.length === 0) return all.includes(own) ? own : null;
  const imp = caller.imports.find((i) => i.specifiers.includes(parts[0]!));
  // A method on a value (`h.RegisterRoutes(api)`): some type's method of that name when one is declared — never
  // the caller's own package's free function, which the value cannot be.
  if (!imp) {
    const methods = all.filter(isMethod);
    const pool = methods.length > 0 ? methods : all.filter((k) => k !== own);
    return pool.length === 1 ? pool[0]! : nearestPackage(pool, dirOf(caller.filePath));
  }
  const keys = all.filter((k) => !isMethod(k));
  const matches = keys.filter((k) => {
    const dir = k.slice(0, k.indexOf("#"));
    return dir !== "" && (imp.source === dir || imp.source.endsWith(`/${dir}`) || imp.source.endsWith(`/${dir.split("/").pop()}`));
  });
  if (matches.length <= 1) return matches[0] ?? null;
  const exact = matches.filter((k) => imp.source.endsWith(`/${k.slice(0, k.indexOf("#"))}`));
  return exact.length === 1 ? exact[0]! : null;
}

/** Of `${dir}#fn` keys, the one sharing the most leading directories with `from`; null on a tie or when none shares any. */
function nearestPackage(keys: string[], from: string): string | null {
  const mine = from.split("/").filter(Boolean);
  const shared = (k: string) => {
    const dir = k.slice(0, k.indexOf("#")).split("/").filter(Boolean);
    let n = 0;
    while (n < dir.length && n < mine.length && dir[n] === mine[n]) n++;
    return n;
  };
  const depth = keys.map(shared);
  const best = Math.max(...depth);
  return best > 0 && depth.filter((d) => d === best).length === 1 ? keys[depth.indexOf(best)]! : null;
}

const HOLE = /\$\{([^{}]*)\}/g;

/**
 * `${config.ApiUri}` in a route path or a router prefix: the value another
 * package states (`ProjectContext.moduleValue`), or nothing when none does —
 * a base the deployment sets is not part of the route, as `cfg.Base + "/x"`
 * is read in the file.
 */
function fillHoles(text: string, file: string, ctx: ProjectContext): string {
  if (!text.includes("${")) return text;
  const filled = text.replace(HOLE, (_hole, expr: string) => {
    const v = ctx.moduleValue?.(file, expr.trim());
    return v !== null && v !== undefined && !v.includes("${") ? v : "";
  });
  return "/" + filled.split("/").filter(Boolean).join("/");
}

/**
 * Router calls handing on a package-level router variable (`via`) take the
 * prefix and guards of the one place in the caller's package that sets it;
 * a variable set in several places, or none, hands on nothing.
 */
function applyPackageRouters(analyses: FileAnalysis[]): void {
  const vars = new Map<string, RouterVar | null>();
  for (const a of analyses) {
    for (const f of a.routeFacts ?? []) {
      if (f.kind !== ROUTER_VAR) continue;
      const v = f.data as RouterVar;
      const key = `${dirOf(a.filePath)}#${v.name}`;
      const prev = vars.get(key);
      vars.set(key, prev === undefined ? v : prev && prev.prefix === v.prefix ? prev : null);
    }
  }
  for (const a of analyses) {
    if (!a.routeFacts?.some((f) => f.kind === ROUTER_CALL && (f.data as RouterCall).via)) continue;
    a.routeFacts = a.routeFacts.flatMap((f) => {
      const call = f.data as RouterCall;
      if (f.kind !== ROUTER_CALL || !call.via) return [f];
      const v = vars.get(`${dirOf(a.filePath)}#${call.via}`);
      if (!v) return [];
      const { via: _via, ...rest } = call;
      return [{ ...f, data: { ...rest, prefix: joinRoutePrefix(v.prefix, call.prefix), guards: [...v.guards, ...call.guards] } satisfies RouterCall }];
    });
  }
}

export const goRouterFnResolver: RouteResolver = {
  id: "go-router-functions",
  languages: ["go"],
  priority: 45,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== ROUTER_CALL && f.kind !== ROUTER_VAR) continue;
        const d = f.data as { prefix: string };
        if (d.prefix.includes("${")) f.data = { ...d, prefix: fillHoles(d.prefix, a.filePath, ctx) };
      }
      if (!a.routes.some((r) => r.path.includes("${"))) continue;
      a.routes = a.routes.map((r) => (r.path.includes("${") ? { ...r, path: fillHoles(r.path, a.filePath, ctx) } : r));
    }
    applyPackageRouters(analyses);
    resolveRouterFunctions(analyses, { unitOf: dirOf, target: targetOf });
  },
};
