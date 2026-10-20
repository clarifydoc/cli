import type { FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { buildAuth, type GuardAttr } from "../../shared/route-metadata.js";
import { GO_ROUTER_CALL, type GoRouterCall } from "./routes.js";

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
 * The extractor marks the function's routes `owner: "fn:Register"` and the
 * call a `go:router-call` fact. A qualified callee (`users.Register`) is the
 * function of that name in the package its import names (the directory the
 * import path ends with); a bare one, in the caller's own package. A call made
 * on the caller's own router parameter is relative to the caller's prefixes,
 * so registrations compose through any depth. A function reached by several
 * calls serves at each of their prefixes; one two packages could be is left
 * alone, as is a function no call reaches. The router's guards at the call
 * (an earlier `Use`, the group's middleware) guard every route it registers.
 */

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const joinPrefix = (prefix: string, path: string): string => "/" + (prefix + "/" + path).split("/").filter(Boolean).join("/");

interface Edge {
  from: string | null;
  prefix: string;
  guards: GuardAttr[];
}

export const goRouterFnResolver: RouteResolver = {
  id: "go-router-functions",
  languages: ["go"],
  priority: 45,
  resolve(analyses: FileAnalysis[]): void {
    // `${dir}#${fn}` → the files in that package with routes the function owns.
    const owners = new Map<string, FileAnalysis[]>();
    const byName = new Map<string, Set<string>>();
    for (const a of analyses) {
      for (const r of a.routes) {
        if (!r.owner?.startsWith("fn:")) continue;
        const fn = r.owner.slice(3);
        const key = `${dirOf(a.filePath)}#${fn}`;
        const files = owners.get(key) ?? owners.set(key, []).get(key)!;
        if (!files.includes(a)) files.push(a);
        (byName.get(fn) ?? byName.set(fn, new Set()).get(fn)!).add(key);
      }
    }
    if (owners.size === 0) return;
    // A function that only hands its router parameter on (`func Setup(rg) { reports(rg.Group("/admin")) }`) is a router function too.
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== GO_ROUTER_CALL || !f.owner || !(f.data as GoRouterCall).relative) continue;
        const key = `${dirOf(a.filePath)}#${f.owner}`;
        (byName.get(f.owner) ?? byName.set(f.owner, new Set()).get(f.owner)!).add(key);
      }
    }

    const incoming = new Map<string, Edge[]>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== GO_ROUTER_CALL) continue;
        const call = f.data as GoRouterCall;
        const target = targetOf(call.callee, a, byName);
        if (!target) continue;
        const from = call.relative && f.owner ? `${dirOf(a.filePath)}#${f.owner}` : null;
        (incoming.get(target) ?? incoming.set(target, []).get(target)!).push({ from, prefix: call.prefix, guards: call.guards });
      }
    }
    if (incoming.size === 0) return;

    // Every prefix (and the guards with it) a router function serves at, composed up to a call with an absolute router.
    const memo = new Map<string, Array<{ prefix: string; guards: GuardAttr[] }>>();
    const onStack = new Set<string>();
    const mounts = (key: string): Array<{ prefix: string; guards: GuardAttr[] }> => {
      const cached = memo.get(key);
      if (cached) return cached;
      const edges = incoming.get(key);
      if (!edges || onStack.has(key)) return [{ prefix: "", guards: [] }];
      onStack.add(key);
      const out: Array<{ prefix: string; guards: GuardAttr[] }> = [];
      for (const e of edges) {
        const bases = e.from ? mounts(e.from) : [{ prefix: "", guards: [] }];
        for (const b of bases) out.push({ prefix: joinPrefix(b.prefix, e.prefix), guards: [...b.guards, ...e.guards] });
      }
      onStack.delete(key);
      const seen = new Set<string>();
      const uniq = out.filter((m) => !seen.has(m.prefix) && seen.add(m.prefix));
      memo.set(key, uniq);
      return uniq;
    };

    for (const [key, files] of owners) {
      if (!incoming.has(key)) continue;
      const fn = key.slice(key.indexOf("#") + 1);
      const at = mounts(key);
      for (const a of files) {
        a.routes = a.routes.flatMap((r): RouteInfo[] =>
          r.owner === `fn:${fn}` ? at.map((m) => withMount(r, m.prefix, m.guards)) : [r],
        );
      }
    }
  },
};

/** The function a call names: in the package a qualifier imports, else in the caller's own. */
function targetOf(callee: string, caller: FileAnalysis, byName: ReadonlyMap<string, Set<string>>): string | null {
  const parts = callee.split(".");
  const fn = parts.pop()!;
  const keys = [...(byName.get(fn) ?? [])];
  if (keys.length === 0) return null;
  const own = `${dirOf(caller.filePath)}#${fn}`;
  if (parts.length === 0) return keys.includes(own) ? own : null;
  const imp = caller.imports.find((i) => i.specifiers.includes(parts[0]!));
  if (!imp) {
    // A method on a value (`h.Register(api)`): its package is not stated — only a unique function will do.
    return keys.length === 1 ? keys[0]! : keys.includes(own) ? own : null;
  }
  // The package directory the import path ends with, deepest match first.
  const matches = keys.filter((k) => {
    const dir = k.slice(0, k.indexOf("#"));
    return dir !== "" && (imp.source === dir || imp.source.endsWith(`/${dir}`) || imp.source.endsWith(`/${dir.split("/").pop()}`));
  });
  if (matches.length <= 1) return matches[0] ?? null;
  const exact = matches.filter((k) => imp.source.endsWith(`/${k.slice(0, k.indexOf("#"))}`));
  return exact.length === 1 ? exact[0]! : null;
}

function withMount(r: RouteInfo, prefix: string, guards: GuardAttr[]): RouteInfo {
  const row: RouteInfo = { ...r, path: joinPrefix(prefix, r.path) };
  if (guards.length === 0) return row;
  row.middleware = [...guards.map((g) => g.text), ...r.middleware];
  const authGuards = guards.filter((g) => (g.policies?.length ?? 0) + (g.roles?.length ?? 0) + (g.schemes?.length ?? 0) > 0);
  const inherited = buildAuth(authGuards, []);
  if (inherited) {
    const own = r.auth;
    const uniq = (xs: string[]) => [...new Set(xs)];
    row.auth = own
      ? { ...own, policies: uniq([...inherited.policies, ...own.policies]), roles: uniq([...inherited.roles, ...own.roles]), schemes: uniq([...inherited.schemes, ...own.schemes]) }
      : inherited;
  }
  return row;
}
