import type { FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import { buildAuth, type GuardAttr } from "../../shared/route-metadata.js";

/**
 * Routes registered by a function on the router it is handed — Go's
 * `func Register(r *gin.RouterGroup)`, Ktor's `fun Route.userRoutes()` — and
 * the calls that hand it one.
 *
 * A plugin marks such routes `owner: "fn:<name>"` (their path is the part the
 * function knows) and each call handing a router on as a `router-call` fact
 * (`RouterCall`: the callee as written, the router's prefix there, whether
 * that prefix is relative to the caller's own router, its guards there). This
 * pass serves every function's routes at each prefix a call reaches it by,
 * composed through relaying functions, with the guards along the way. Which
 * function a callee names is the plugin's rule (`target`): a package for Go,
 * a name for Kotlin. A callee that could be two functions joins neither; a
 * function no call reaches keeps its paths.
 */

export const ROUTER_CALL = "router-call";

export interface RouterCall {
  callee: string;
  prefix: string;
  relative: boolean;
  guards: GuardAttr[];
}

export interface RouterFunctionRules {
  /** The unit a function name is unique in: Go's package directory, a Kotlin file. */
  unitOf(filePath: string): string;
  /** The `${unit}#${fn}` key a callee names from the caller, among the known router functions of that name. */
  target(callee: string, caller: FileAnalysis, keysNamed: (fn: string) => string[]): string | null;
}

export const joinRoutePrefix = (prefix: string, path: string): string => "/" + (prefix + "/" + path).split("/").filter(Boolean).join("/");

interface Mount {
  prefix: string;
  guards: GuardAttr[];
}

export function resolveRouterFunctions(analyses: FileAnalysis[], rules: RouterFunctionRules): void {
  const owners = new Map<string, FileAnalysis[]>();
  const byName = new Map<string, Set<string>>();
  const add = (fn: string, key: string) => (byName.get(fn) ?? byName.set(fn, new Set()).get(fn)!).add(key);
  for (const a of analyses) {
    for (const r of a.routes) {
      if (!r.owner?.startsWith("fn:")) continue;
      const fn = r.owner.slice(3);
      const key = `${rules.unitOf(a.filePath)}#${fn}`;
      const files = owners.get(key) ?? owners.set(key, []).get(key)!;
      if (!files.includes(a)) files.push(a);
      add(fn, key);
    }
  }
  if (owners.size === 0) return;
  // A function that only hands its own router on is a router function too.
  for (const a of analyses) {
    for (const f of a.routeFacts ?? []) {
      if (f.kind === ROUTER_CALL && f.owner && (f.data as RouterCall).relative) add(f.owner, `${rules.unitOf(a.filePath)}#${f.owner}`);
    }
  }
  const keysNamed = (fn: string) => [...(byName.get(fn) ?? [])];

  const incoming = new Map<string, Array<{ from: string | null } & Mount>>();
  for (const a of analyses) {
    for (const f of a.routeFacts ?? []) {
      if (f.kind !== ROUTER_CALL) continue;
      const call = f.data as RouterCall;
      const target = rules.target(call.callee, a, keysNamed);
      if (!target) continue;
      const from = call.relative && f.owner ? `${rules.unitOf(a.filePath)}#${f.owner}` : null;
      (incoming.get(target) ?? incoming.set(target, []).get(target)!).push({ from, prefix: call.prefix, guards: call.guards });
    }
  }
  if (incoming.size === 0) return;

  const memo = new Map<string, Mount[]>();
  const onStack = new Set<string>();
  const mounts = (key: string): Mount[] => {
    const cached = memo.get(key);
    if (cached) return cached;
    const edges = incoming.get(key);
    if (!edges || onStack.has(key)) return [{ prefix: "", guards: [] }];
    onStack.add(key);
    const out: Mount[] = [];
    for (const e of edges) {
      for (const b of e.from ? mounts(e.from) : [{ prefix: "", guards: [] }]) {
        out.push({ prefix: joinRoutePrefix(b.prefix, e.prefix), guards: [...b.guards, ...e.guards] });
      }
    }
    onStack.delete(key);
    const seen = new Set<string>();
    const uniq = out.filter((m) => (seen.has(m.prefix) ? false : (seen.add(m.prefix), true)));
    memo.set(key, uniq);
    return uniq;
  };

  for (const [key, files] of owners) {
    if (!incoming.has(key)) continue;
    const owner = `fn:${key.slice(key.indexOf("#") + 1)}`;
    const at = mounts(key);
    for (const a of files) {
      a.routes = a.routes.flatMap((r): RouteInfo[] => (r.owner === owner ? at.map((m) => withMount(r, m)) : [r]));
    }
  }
}

function withMount(r: RouteInfo, m: Mount): RouteInfo {
  const row: RouteInfo = { ...r, path: joinRoutePrefix(m.prefix, r.path) };
  if (m.guards.length === 0) return row;
  row.middleware = [...m.guards.map((g) => g.text), ...r.middleware];
  const authGuards = m.guards.filter((g) => (g.policies?.length ?? 0) + (g.roles?.length ?? 0) + (g.schemes?.length ?? 0) > 0);
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
