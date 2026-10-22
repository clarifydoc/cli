import type { ClassInfo, DataSourceInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { SELF_HEADS, isConstructor } from "./typed-receivers.js";

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

    const emit = (fn: FunctionInfo, scope: ReadonlyMap<string, string>) => {
      for (const call of fn.calls) {
        const parts = call.name.split(".");
        if (parts.length < 2) continue;
        let receiver = parts.slice(0, -1);
        if (receiver.length === 2 && SELF_HEADS.has(receiver[0]!)) receiver = receiver.slice(1);
        if (receiver.length !== 1 || !/^[A-Za-z_$][\w$]*$/.test(receiver[0]!)) continue;
        const type = scope.get(receiver[0]!);
        if (!type) continue;
        const method = parts[parts.length - 1]!;
        if (!/^[A-Za-z_$][\w$]*$/.test(method)) continue;
        out.push({
          kind: "api-call",
          name: `${type.split(".").pop()}.${method}`,
          target: null,
          line: call.line,
          calls: [],
          filePath: a.filePath,
          contract: { type, method },
          baseRef: { kind: "client", key: type },
        });
      }
    };
    const scopeOf = (fn: FunctionInfo, members: ReadonlyMap<string, string>) => {
      const scope = new Map(members);
      for (const p of fn.params) {
        const t = proxyOf(p.type);
        if (t) scope.set(p.name, t);
      }
      for (const l of fn.localTypes ?? []) {
        const t = proxyOf(l.type);
        if (t) scope.set(l.name, t);
      }
      return scope;
    };
    const membersOf = (cls: ClassInfo) => {
      const members = new Map<string, string>();
      for (const p of cls.properties) {
        const t = proxyOf(p.type);
        if (t) members.set(p.name, t);
      }
      for (const m of cls.methods) {
        if (!isConstructor(m, cls)) continue;
        for (const p of m.params) {
          const t = proxyOf(p.type);
          if (t) members.set(p.name, t);
        }
      }
      return members;
    };

    // Module-level instances — this file's own (`const api = new ClubsApi(cfg)`) and those
    // a module it imports exports (`export const clubsApi = new ClubsApi(cfg)`) — are in
    // scope in every function of the file.
    const moduleScope = new Map<string, string>();
    const moduleTypes = (f: FileAnalysis | undefined) => f?.functions.find((fn) => fn.name === "<setup>")?.localTypes ?? [];
    for (const l of moduleTypes(a)) {
      const t = proxyOf(l.type);
      if (t) moduleScope.set(l.name, t);
    }
    if (localFor) {
      for (const imp of a.imports) {
        for (const spec of imp.specifiers ?? []) {
          if (moduleScope.has(spec)) continue;
          const from = localFor(a.filePath, spec);
          const l = from ? moduleTypes(byPath.get(from)).find((x) => x.name === spec) : undefined;
          const t = l ? proxyOfIn(byPath.get(from!)!, l.type) : null;
          if (t) moduleScope.set(spec, t);
        }
      }
    }
    for (const fn of a.functions) emit(fn, scopeOf(fn, moduleScope));
    for (const cls of a.classes) {
      const members = new Map([...moduleScope, ...membersOf(cls)]);
      for (const m of cls.methods) emit(m, scopeOf(m, members));
    }
  }
  return out;
}
