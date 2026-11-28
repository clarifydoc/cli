import type { FileAnalysis } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import type { ProjectContext } from "../../../types/project.js";
import { ROUTER_CALL, joinRoutePrefix, resolveRouterFunctions, type RouterCall } from "../shared/router-functions.js";
import { FUNC_REF, ROUTER_VAR, middlewareCallees, type RouterVar } from "./routes.js";

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

/** The one type a local of the caller is declared (or built) as, by bare name; null when none or several differ. */
function declaredTypeOf(caller: FileAnalysis, name: string): string | null {
  const types = new Set<string>();
  const scopes = [...caller.functions, ...caller.classes.flatMap((c) => c.methods)];
  for (const fn of scopes) {
    for (const l of fn.localTypes ?? []) {
      if (l.name !== name || !l.type) continue;
      types.add(l.type.replace(/^[*&\[\]]+/, "").replace(/\{.*$/, "").split(".").pop()!);
    }
  }
  return types.size === 1 ? [...types][0]! : null;
}

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
    let methods = all.filter(isMethod);
    // The value's declared type (`h := &users.Handler{}`, `h := users.Handler{…}`) names whose method it is.
    const type = declaredTypeOf(caller, parts[0]!);
    if (type && methods.length > 1) {
      const typed = methods.filter((k) => k.endsWith(`#${type}.${fn}`));
      if (typed.length > 0) methods = typed;
    }
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

/**
 * A register function nothing calls is dead when no other repository could call it: an unexported one (only its own
 * package can), or an exported one in a package some scanned file imports (its callers would be among them). An exported
 * function in a package nobody scanned imports is a library's entry point and keeps its routes.
 */
function deadRule(handed: ReadonlySet<string>, ctx: ProjectContext): (unit: string, fn: string, analyses: readonly FileAnalysis[]) => boolean {
  // The package directories some scanned file imports, through the import index (a namesake directory is not one); without
  // an index, an import whose path ends in the directory.
  let imported: Set<string> | null = null;
  const isImported = (unit: string, analyses: readonly FileAnalysis[]): boolean => {
    if (!ctx.importIndex?.fileForSource) return analyses.some((a) => a.imports.some((i) => i.source === unit || i.source.endsWith(`/${unit}`)));
    if (!imported) {
      imported = new Set<string>();
      for (const a of analyses) {
        for (const i of a.imports) {
          const file = ctx.importIndex.fileForSource(a.filePath, i.source);
          if (file) imported.add(dirOf(file));
        }
      }
    }
    return imported.has(unit);
  };
  return (unit, fn, analyses) => {
    const leaf = fn.slice(fn.lastIndexOf(".") + 1);
    if (handed.has(leaf)) return false;
    if (!/^[A-Z]/.test(leaf)) return true;
    return unit !== "" && isImported(unit, analyses);
  };
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

/**
 * Routes registered by a function on the router it is handed (`func Register(r *gin.RouterGroup)`) are `owner:
 * "fn:<name>"` rows plus `router-call` facts, composed with ../shared/router-functions.ts. The mount site's guards
 * (`api := r.Group("/api", auth.Required()); clubs.Register(api)`) become `RouteInfo.inheritedMiddleware`, resolved
 * in the mount's file and joined as `viaMiddleware`. A route prefix from a constant (`router.Group(config.ApiUri)`)
 * is filled through the module-value pass (module-values.ts).
 */
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
    // A call handing on a package router no one sets is dropped below, but it is still a call: its callee is not dead.
    const handed = new Set<string>();
    // A function stored or handed on as a value (`registerDocs = api.GetDocs`, a table of them) is called where it lands.
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === ROUTER_CALL) { const c = (f.data as RouterCall).callee; handed.add(c.slice(c.lastIndexOf(".") + 1)); }
        else if (f.kind === FUNC_REF) for (const n of (f.data as { names: string[] }).names) handed.add(n);
      }
    }
    applyPackageRouters(analyses);
    resolveRouterFunctions(analyses, { unitOf: dirOf, target: targetOf, guardCalls: middlewareCallees, uncalledIsDead: deadRule(handed, ctx) });
  },
};
