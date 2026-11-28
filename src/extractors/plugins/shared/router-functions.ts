import type { FileAnalysis, RouteFact, RouteInfo } from "../../../types/analysis.js";
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
 * a name for Kotlin. A callee that could be two functions joins neither. A
 * function no call reaches keeps its paths, unless the plugin says its caller
 * would be visible here (`uncalledIsDead`): then nothing serves those routes,
 * they are dropped, and so is a function only such a function hands its router
 * to (a dead `registerOld(g)` mounts nothing at a guessed path).
 *
 * The `fn:` marker lives only during the pass: at its end every row it collected loses `owner` (served, kept
 * uncalled, or dropped-dead's neighbours), since the symbol linker reads `owner` as a class name.
 * `skipPlain` leaves a function whose every call hands on the bare root as written; `served` tells the plugin which
 * calls reached a function this pass composed.
 */

export const ROUTER_CALL = "router-call";

export interface RouterCall {
  callee: string;
  prefix: string;
  relative: boolean;
  guards: GuardAttr[];
  /**
   * The router handed on is a package-level variable another file sets
   * (Go `api.CreateSession(APIv1)`): the plugin's resolver puts that
   * variable's prefix and guards in front before this pass runs, and drops
   * the call when no one place sets it.
   */
  via?: string;
}

export interface RouterFunctionRules {
  /** The unit a function name is unique in: Go's package directory, a Kotlin file. */
  unitOf(filePath: string): string;
  /** The `${unit}#${fn}` key a callee names from the caller, among the known router functions of that name. */
  target(callee: string, caller: FileAnalysis, keysNamed: (fn: string) => string[]): string | null;
  /**
   * The functions a list of guard texts names (`RouteInfo.middlewareCalls`), for the guards a mount adds to a route:
   * the symbol linker joins what they read to the route's flows. Absent: a mount's guards name no calls.
   */
  guardCalls?(guards: readonly string[]): string[];
  /**
   * True when a function that nothing in the scan calls (no router-call reaches it and no call anywhere names it)
   * cannot have a caller outside it either — Go's unexported function, or an exported one in a package the scan
   * imports. False keeps its routes: a library's exported register function is called from another repository.
   * Absent: every uncalled function keeps its routes.
   */
  uncalledIsDead?(unit: string, fn: string, analyses: readonly FileAnalysis[]): boolean;
  /**
   * True: a function every call of which hands on the application root (prefix "", no guards, not relative) is left
   * as written — composing would only respell its paths.
   */
  skipPlain?: boolean;
  /** Called once per call that reaches a function this pass serves (not a skipped one), with the file the call is in. */
  served?(call: RouteFact, caller: FileAnalysis): void;
}

export const joinRoutePrefix = (prefix: string, path: string): string => "/" + (prefix + "/" + path).split("/").filter(Boolean).join("/");

interface Mount {
  prefix: string;
  guards: GuardAttr[];
  /** The file each guard is written in (parallel to `guards`): its callee names resolve there. */
  files: string[];
}

export function resolveRouterFunctions(analyses: FileAnalysis[], rules: RouterFunctionRules): void {
  const owners = new Map<string, FileAnalysis[]>();
  composeOwned(analyses, rules, owners);
  // The marker lives only during the pass: no reader after it takes `fn:` for anything.
  for (const files of owners.values()) {
    for (const a of files) for (const r of a.routes) if (r.owner?.startsWith("fn:")) delete r.owner;
  }
}

function composeOwned(analyses: FileAnalysis[], rules: RouterFunctionRules, owners: Map<string, FileAnalysis[]>): void {
  const byName = new Map<string, Set<string>>();
  // A method (`Handler.Register`) answers to its own name too: a call on a value names only that.
  const add = (fn: string, key: string) => {
    for (const name of new Set([fn, fn.slice(fn.lastIndexOf(".") + 1)])) (byName.get(name) ?? byName.set(name, new Set()).get(name)!).add(key);
  };
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
  const leafOf = (fn: string) => fn.slice(fn.lastIndexOf(".") + 1);
  // The bare names any call in the scan names (`registerOld`, `users.Register` → `Register`, `h.Mount` → `Mount`).
  let called: Set<string> | null = null;
  const isCalled = (fn: string): boolean => {
    if (!called) {
      called = new Set<string>();
      for (const a of analyses) {
        for (const f of [...a.functions, ...a.classes.flatMap((c) => c.methods ?? [])]) {
          for (const c of f.calls ?? []) called.add(leafOf(c.name));
        }
      }
    }
    return called.has(leafOf(fn));
  };
  // A function that only hands its own router on is a router function too.
  for (const a of analyses) {
    for (const f of a.routeFacts ?? []) {
      if (f.kind === ROUTER_CALL && f.owner && (f.data as RouterCall).relative) add(f.owner, `${rules.unitOf(a.filePath)}#${f.owner}`);
    }
  }
  const keysNamed = (fn: string) => [...(byName.get(fn) ?? [])];

  const incoming = new Map<string, Array<{ from: string | null; file: string; prefix: string; guards: GuardAttr[]; fact: RouteFact; caller: FileAnalysis }>>();
  for (const a of analyses) {
    for (const f of a.routeFacts ?? []) {
      if (f.kind !== ROUTER_CALL) continue;
      const call = f.data as RouterCall;
      const target = rules.target(call.callee, a, keysNamed);
      if (!target) continue;
      const from = call.relative && f.owner ? `${rules.unitOf(a.filePath)}#${f.owner}` : null;
      (incoming.get(target) ?? incoming.set(target, []).get(target)!).push({ from, file: a.filePath, prefix: call.prefix, guards: call.guards, fact: f, caller: a });
    }
  }
  // Functions left as written: every call hands on the root.
  const plain = new Set<string>();
  if (rules.skipPlain) {
    for (const [key, edges] of incoming) {
      if (edges.every((e) => e.from === null && e.prefix === "" && e.guards.length === 0)) plain.add(key);
    }
    for (const key of plain) incoming.delete(key);
  }
  for (const edges of incoming.values()) for (const e of edges) rules.served?.(e.fact, e.caller);
  if (incoming.size === 0 && !rules.uncalledIsDead) return;

  const deadMemo = new Map<string, boolean>();
  /** No call reaches the function, nothing names it, and the plugin sees every place that could. */
  const isDead = (key: string): boolean => {
    if (incoming.has(key) || plain.has(key) || !rules.uncalledIsDead) return false;
    const known = deadMemo.get(key);
    if (known !== undefined) return known;
    const fn = key.slice(key.indexOf("#") + 1);
    const dead = !isCalled(fn) && rules.uncalledIsDead(key.slice(0, key.indexOf("#")), fn, analyses);
    deadMemo.set(key, dead);
    return dead;
  };

  const memo = new Map<string, Mount[]>();
  const onStack = new Set<string>();
  const mounts = (key: string): Mount[] => {
    const cached = memo.get(key);
    if (cached) return cached;
    const edges = incoming.get(key);
    if (!edges || onStack.has(key)) return [{ prefix: "", guards: [], files: [] }];
    onStack.add(key);
    const out: Mount[] = [];
    for (const e of edges) {
      if (e.from && isDead(e.from)) continue;
      for (const b of e.from ? mounts(e.from) : [{ prefix: "", guards: [], files: [] }]) {
        out.push({ prefix: joinRoutePrefix(b.prefix, e.prefix), guards: [...b.guards, ...e.guards], files: [...b.files, ...e.guards.map(() => e.file)] });
      }
    }
    onStack.delete(key);
    const seen = new Set<string>();
    const uniq = out.filter((m) => (seen.has(m.prefix) ? false : (seen.add(m.prefix), true)));
    memo.set(key, uniq);
    return uniq;
  };

  for (const [key, files] of owners) {
    const owner = `fn:${key.slice(key.indexOf("#") + 1)}`;
    if (!incoming.has(key)) {
      if (isDead(key)) for (const a of files) a.routes = a.routes.filter((r) => r.owner !== owner);
      continue;
    }
    const at = mounts(key);
    for (const a of files) {
      a.routes = a.routes.flatMap((r): RouteInfo[] => (r.owner === owner ? at.map((m) => withMount(r, m, rules)) : [r]));
    }
  }
}

function withMount(r: RouteInfo, m: Mount, rules: RouterFunctionRules): RouteInfo {
  const row: RouteInfo = { ...r, path: joinRoutePrefix(m.prefix, r.path) };
  if (m.guards.length === 0) return row;
  row.middleware = [...m.guards.map((g) => g.text), ...r.middleware];
  // What the mount's guards name is resolved where the mount is written, not in the route's own file.
  const named: Array<{ file: string; calls: string[] }> = [];
  for (const file of new Set(m.files)) {
    const calls = rules.guardCalls?.(m.guards.filter((_, i) => m.files[i] === file).map((g) => g.text)) ?? [];
    if (calls.length > 0) named.push({ file, calls });
  }
  if (named.length > 0) row.inheritedMiddleware = [...named, ...(r.inheritedMiddleware ?? [])];
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
