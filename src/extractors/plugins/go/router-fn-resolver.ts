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
 * package is not stated) only the one function of that name.
 */

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function targetOf(callee: string, caller: FileAnalysis, keysNamed: (fn: string) => string[]): string | null {
  const parts = callee.split(".");
  const fn = parts.pop()!;
  const keys = keysNamed(fn);
  if (keys.length === 0) return null;
  const own = `${dirOf(caller.filePath)}#${fn}`;
  if (parts.length === 0) return keys.includes(own) ? own : null;
  const imp = caller.imports.find((i) => i.specifiers.includes(parts[0]!));
  if (!imp) return keys.length === 1 ? keys[0]! : keys.includes(own) ? own : null;
  const matches = keys.filter((k) => {
    const dir = k.slice(0, k.indexOf("#"));
    return dir !== "" && (imp.source === dir || imp.source.endsWith(`/${dir}`) || imp.source.endsWith(`/${dir.split("/").pop()}`));
  });
  if (matches.length <= 1) return matches[0] ?? null;
  const exact = matches.filter((k) => imp.source.endsWith(`/${k.slice(0, k.indexOf("#"))}`));
  return exact.length === 1 ? exact[0]! : null;
}

export const goRouterFnResolver: RouteResolver = {
  id: "go-router-functions",
  languages: ["go"],
  priority: 45,
  resolve(analyses: FileAnalysis[]): void {
    resolveRouterFunctions(analyses, { unitOf: dirOf, target: targetOf });
  },
};
