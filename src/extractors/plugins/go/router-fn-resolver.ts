import type { FileAnalysis } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { resolveRouterFunctions } from "../shared/router-functions.js";

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

export const goRouterFnResolver: RouteResolver = {
  id: "go-router-functions",
  languages: ["go"],
  priority: 45,
  resolve(analyses: FileAnalysis[]): void {
    resolveRouterFunctions(analyses, { unitOf: dirOf, target: targetOf });
  },
};
