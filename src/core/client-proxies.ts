import type { ClassInfo, DataSourceInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { SELF_HEADS, isConstructor } from "./typed-receivers.js";
import { resolveImportSource } from "./import-index.js";
import { isTestFile } from "./test-file-detector.js";
import { extensionFamily } from "../extractors/plugins/shared/path-utils.js";

type ApiCall = DataSourceInfo & { filePath: string };

/**
 * Calls through REST client proxies, as outbound API calls.
 *
 * A proxy implements an API interface and turns each method call into the
 * request the interface's annotations declare (JAX-RS, Feign, MicroProfile,
 * Spring HTTP interfaces). In the calling code nothing says HTTP —
 * `personRepository.getPerson(id, …)` is an ordinary call on an
 * interface-typed field — and the URL usually lives in a shared API jar the
 * repository does not contain. What IS stated: the proxy registration
 * (`HttpClientRegistration.proxyOf`, from a Spring XML factory bean or a
 * `RestClient.createClient(X.class, url)` call) and the receiver's declared
 * type. Every call on a receiver of a proxied type becomes an api-call
 * carrying its `contract` — the interface operation — and `baseRef` to the
 * registration (for where the service is). The route linker joins it to the
 * route declared on the same operation, here or in another repository.
 *
 * Language-agnostic: declared types come from the classes and functions any
 * plugin reports, a simple type name is qualified through the file's imports
 * (`import a.b.PersonApi` → `a.b.PersonApi`), or by being the one registered
 * type of that name.
 */
export function clientProxyCalls(
  analyses: readonly FileAnalysis[],
  /** The project file an imported name comes from (`importIndex.localFor`): a client instance a module exports. */
  localFor?: (file: string, name: string) => string | null,
): ApiCall[] {
  const proxied = new Set<string>();
  const bySimple = new Map<string, Set<string>>();
  for (const a of analyses) {
    for (const r of a.httpClientRegistrations ?? []) {
      if (!r.proxyOf) continue;
      proxied.add(r.proxyOf);
      const simple = r.proxyOf.split(".").pop()!;
      (bySimple.get(simple) ?? bySimple.set(simple, new Set()).get(simple)!).add(r.proxyOf);
    }
  }
  if (proxied.size === 0) return [];

  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  /** A type as another file names it: the proxied type, simple or qualified. */
  const proxyOfIn = (_f: FileAnalysis, raw: string): string | null => {
    const t = raw.trim();
    if (proxied.has(t)) return t;
    const cands = bySimple.get(t.split(".").pop()!);
    return cands?.size === 1 ? [...cands][0]! : null;
  };
  const moduleTypes = (f: FileAnalysis | undefined) => f?.functions.find((fn) => fn.name === "<setup>")?.localTypes ?? [];
  const knownFiles = new Set(byPath.keys());
  /**
   * The module that holds what `file` exports as `name`, and its own name there — through
   * `export { defaultLeagueClient as leagueClient }` and barrels (`export * from "./client"`).
   * Two barrels leading to different modules decide nothing.
   */
  const holderOf = (file: string, name: string, depth: number, seen: Set<string>): { file: FileAnalysis; local: string } | null => {
    const f = byPath.get(file);
    if (!f || depth > 5 || seen.has(file)) return null;
    seen.add(file);
    const local = f.exports.find((e) => e.name === name && !e.source)?.sourceName ?? name;
    if (moduleTypes(f).some((l) => l.name === local || l.name.startsWith(local + "."))) return { file: f, local };
    let found: { file: FileAnalysis; local: string } | null = null;
    for (const e of f.exports) {
      if (e.kind !== "re-export" || !e.source || (e.name !== name && e.name !== "*")) continue;
      const target = resolveImportSource(file, e.source, knownFiles);
      const hit = target ? holderOf(target, e.name === "*" ? name : e.sourceName ?? name, depth + 1, seen) : null;
      if (!hit) continue;
      if (found && found.file !== hit.file) return null;
      found = hit;
    }
    return found;
  };
  // A project class by its simple name (one of that name), for a member holding a proxy one level down.
  const classesNamed = new Map<string, Array<{ file: string; cls: ClassInfo }>>();
  for (const a of analyses) for (const c of a.classes) (classesNamed.get(c.name) ?? classesNamed.set(c.name, []).get(c.name)!).push({ file: a.filePath, cls: c });
  /** The one class of that name in the caller's language family — a test's own fake only for a test. */
  const classFor = (name: string, from: FileAnalysis): ClassInfo | undefined => {
    const fromTest = isTestFile(from.filePath, from.language);
    const hits = (classesNamed.get(name) ?? []).filter((h) => extensionFamily(h.file) === extensionFamily(from.filePath) && (fromTest || !isTestFile(h.file, byPath.get(h.file)?.language ?? from.language)));
    return hits.length === 1 ? hits[0]!.cls : undefined;
  };
  const out: ApiCall[] = [];
  for (const a of analyses) {
    const imported = new Map<string, string>();
    for (const imp of a.imports) {
      for (const spec of imp.specifiers ?? []) if (imp.source.endsWith("." + spec)) imported.set(spec, imp.source);
    }
    const proxyOf = (raw: string | null | undefined): string | null => {
      const t = receiverTypeName(raw, a.language) ?? raw?.trim() ?? null;
      if (!t) return null;
      if (proxied.has(t)) return t;
      const imp = imported.get(t);
      if (imp) return proxied.has(imp) ? imp : null;
      // Not imported: the same package, or a name only one registration has.
      const cands = bySimple.get(t);
      return cands?.size === 1 ? [...cands][0]! : null;
    };

    const emit = (fn: FunctionInfo, scope: ReadonlyMap<string, string>, returns?: ReadonlyMap<string, string>) => {
      for (const call of fn.calls) {
        // `getClubService(id).getClub(id)`: a method of the same class declared to return the proxy.
        const helper = returns?.size ? helperCall(call.name) : null;
        const returned = helper ? returns!.get(helper.fn) : undefined;
        if (helper && returned) {
          out.push(contractCall(returned, helper.method, call.line, a.filePath));
          continue;
        }
        // `Factory.fromClient(client, PersonApi.class).getPerson(id)`: the plugin states the receiver's type.
        const stated = call.receiverType ? proxyOf(call.receiverType) : null;
        const statedMethod = stated ? /\.([A-Za-z_$][\w$]*)$/.exec(call.name)?.[1] : undefined;
        if (stated && statedMethod) {
          out.push(contractCall(stated, statedMethod, call.line, a.filePath));
          continue;
        }
        const parts = call.name.split(".");
        if (parts.length < 2) continue;
        let receiver = parts.slice(0, -1);
        if (receiver.length >= 2 && SELF_HEADS.has(receiver[0]!)) receiver = receiver.slice(1);
        // `api.content.clubs.listClubs()`: a path into a module-level client object (`<setup>`'s `api.content.clubs`).
        if (receiver.length > 4 || !receiver.every((r) => /^[A-Za-z_$][\w$]*$/.test(r))) continue;
        const type = scope.get(receiver.join("."));
        if (!type) continue;
        const method = parts[parts.length - 1]!;
        if (!/^[A-Za-z_$][\w$]*$/.test(method)) continue;
        out.push(contractCall(type, method, call.line, a.filePath));
      }
    };
    /**
     * `name` typed `raw`: the proxy itself, or — a project class holding proxies
     * (`final ApiService _apiService;` whose `AuthenticationApi authenticationApi`) —
     * each proxy member under `name.member`.
     */
    const bind = (into: Map<string, string>, name: string, raw: string | null | undefined): void => {
      const t = proxyOf(raw);
      if (t) {
        into.set(name, t);
        return;
      }
      const held = raw ? classFor(receiverTypeName(raw, a.language) ?? raw.trim(), a) : undefined;
      for (const p of held?.properties ?? []) {
        const inner = proxyOf(p.type);
        if (inner) into.set(`${name}.${p.name}`, inner);
      }
    };
    const scopeOf = (fn: FunctionInfo, members: ReadonlyMap<string, string>) => {
      const scope = new Map(members);
      for (const p of fn.params) bind(scope, p.name, p.type);
      for (const l of fn.localTypes ?? []) bind(scope, l.name, l.type);
      return scope;
    };
    const membersOf = (cls: ClassInfo) => {
      const members = new Map<string, string>();
      for (const p of cls.properties) bind(members, p.name, p.type);
      for (const m of cls.methods) {
        if (!isConstructor(m, cls)) continue;
        for (const p of m.params) bind(members, p.name, p.type);
      }
      return members;
    };

    // Module-level instances — this file's own (`const api = new ClubsApi(cfg)`) and those
    // a module it imports exports (`export const clubsApi = new ClubsApi(cfg)`) — are in
    // scope in every function of the file.
    const moduleScope = new Map<string, string>();
    for (const l of moduleTypes(a)) {
      const t = proxyOf(l.type);
      if (t) moduleScope.set(l.name, t);
    }
    if (localFor) {
      for (const imp of a.imports) {
        for (const spec of imp.specifiers ?? []) {
          if (moduleScope.has(spec)) continue;
          const from = localFor(a.filePath, spec);
          const held = from ? holderOf(from, spec, 0, new Set()) : null;
          if (!held) continue;
          for (const l of moduleTypes(held.file)) {
            if (l.name !== held.local && !l.name.startsWith(held.local + ".")) continue;
            const t = proxyOfIn(held.file, l.type);
            if (t) moduleScope.set(spec + l.name.slice(held.local.length), t);
          }
        }
      }
    }
    for (const fn of a.functions) emit(fn, scopeOf(fn, moduleScope));
    for (const cls of a.classes) {
      const members = new Map([...moduleScope, ...membersOf(cls)]);
      const returns = new Map<string, string>();
      for (const m of cls.methods) {
        const t = proxyOf(m.returnType);
        if (t) returns.set(m.name, t);
      }
      for (const m of cls.methods) emit(m, scopeOf(m, members), returns);
    }
  }
  return out;
}

function contractCall(type: string, method: string, line: number, filePath: string): ApiCall {
  return {
    kind: "api-call",
    name: `${type.split(".").pop()}.${method}`,
    target: null,
    line,
    calls: [],
    filePath,
    contract: { type, method },
    baseRef: { kind: "client", key: type },
  };
}

/** `helper(args).method` / `this.helper(args).method` → its parts; null for any other shape. */
function helperCall(name: string): { fn: string; method: string } | null {
  const head = /^(?:this\.)?([A-Za-z_$][\w$]*)\(/.exec(name);
  if (!head) return null;
  let depth = 0;
  for (let i = head[0].length - 1; i < name.length; i++) {
    if (name[i] === "(") depth++;
    else if (name[i] === ")" && --depth === 0) {
      const method = /^\.([A-Za-z_$][\w$]*)$/.exec(name.slice(i + 1))?.[1];
      return method ? { fn: head[1]!, method } : null;
    }
  }
  return null;
}

/**
 * The API interfaces a project only calls: each type a client-proxy registration
 * names (`HttpClientRegistration.proxyOf`) that no class of the project
 * implements or extends. Its routes are the remote service's endpoints, which
 * this project reaches through the proxy — not routes it serves.
 */
export function proxiedOnlyTypes(analyses: readonly FileAnalysis[]): Set<string> {
  const proxied = new Set<string>();
  for (const a of analyses) for (const r of a.httpClientRegistrations ?? []) if (r.proxyOf) proxied.add(r.proxyOf);
  if (proxied.size === 0) return proxied;
  const simple = (t: string) => t.replace(/<.*$/s, "").trim().split(".").pop()!;
  const implemented = new Set<string>();
  for (const a of analyses) {
    for (const c of a.classes) for (const t of [...(c.implements ?? []), ...(c.extends ? [c.extends] : [])]) implemented.add(simple(t));
  }
  return new Set([...proxied].filter((t) => !implemented.has(simple(t))));
}

/**
 * The API-contract rows (a WSDL, an OpenAPI document) a project only consumes:
 * the row's contract type is one the project reaches only through a client
 * proxy (`proxiedOnlyTypes` — a `getPort(X.class)`, a generated client no class
 * implements), and no code route implements the row (`implemented`: its code
 * twin or the spec join of its own sub-project). The document is bundled so
 * the client has the binding; the operation is served elsewhere. The rows are
 * kept — the project's contract calls join them — and marked `consumed`, so
 * nothing counts them as routes the project serves. Returns how many it marked.
 */
export function markConsumedContracts<R extends { kind: string; contract?: { type: string; method: string }; consumed?: true }>(
  routes: readonly R[],
  proxiedOnly: ReadonlySet<string>,
  isContract: (route: R) => boolean,
  implemented: (route: R) => boolean,
): number {
  if (proxiedOnly.size === 0) return 0;
  const simple = (t: string) => t.slice(t.lastIndexOf(".") + 1);
  const bySimple = new Set([...proxiedOnly].map(simple));
  // The same rule as the linker's contract join: a qualified type names
  // exactly; a document that states no package (a WSDL portType) by its name.
  const consumedType = (t: string) => proxiedOnly.has(t) || (!t.includes(".") && bySimple.has(t));
  let marked = 0;
  for (const r of routes) {
    if (r.kind !== "api" || !r.contract || !isContract(r) || !consumedType(r.contract.type) || implemented(r)) continue;
    r.consumed = true;
    marked++;
  }
  return marked;
}

/**
 * A call through a client proxy is a request, not also a database access: a
 * plugin that reads a repository-named receiver (`personRepository.findPersons(…)`)
 * as a data-access row cannot see per file that the receiver is a REST proxy.
 * Drops the database row each contract call shadows — same file, same line,
 * the operation's method named — and returns how many went.
 */
export function dropProxiedDatabaseRows(analyses: readonly FileAnalysis[], proxyCalls: readonly ApiCall[]): number {
  const shadowed = new Map<string, Set<string>>();
  for (const c of proxyCalls) {
    // A contract call names its operation; a gRPC stub call's path ends with its rpc (`/pkg.Svc/Convert`).
    const method = c.contract?.method ?? (c.target ? /\/([A-Za-z_]\w*)$/.exec(c.target)?.[1] : undefined);
    if (!method) continue;
    const key = `${c.filePath}\0${c.line}`;
    (shadowed.get(key) ?? shadowed.set(key, new Set()).get(key)!).add(method.toLowerCase());
  }
  if (shadowed.size === 0) return 0;
  let dropped = 0;
  for (const a of analyses) {
    if (!a.dataSources?.length) continue;
    const kept = a.dataSources.filter((ds) => {
      if (ds.kind !== "database") return true;
      const methods = shadowed.get(`${a.filePath}\0${ds.line}`);
      const method = /([A-Za-z_$][\w$]*)\s*$/.exec(ds.name)?.[1];
      // gRPC stubs name an rpc in the language's case (`client.convert` for `Convert`).
      if (!methods || !method || !methods.has(method.toLowerCase())) return true;
      dropped++;
      return false;
    });
    if (kept.length !== a.dataSources.length) a.dataSources = kept;
  }
  return dropped;
}
