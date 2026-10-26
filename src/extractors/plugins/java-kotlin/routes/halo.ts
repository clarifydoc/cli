import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";

/**
 * Halo (halo.run) generates endpoints at runtime from what its classes state:
 *
 *   - an extension class annotated `@GVK(group, version, kind, plural, …)` gets
 *     the CRUD routes of `ExtensionRouterFunctionFactory`: list and create on
 *     `/apis/{group}/{version}/{plural}` (`/api/{version}/{plural}` for the
 *     core group `""`), get / update / patch / delete on `…/{name}`;
 *   - a `CustomEndpoint` serves its functional routes under
 *     `/apis/{group}/{version}` from `groupVersion()` — Halo's default,
 *     `api.console.halo.run/v1alpha1`, when the class does not override it
 *     (spring.ts applies the prefix; `customEndpointPrefix` computes it).
 *
 * Without these a Halo console's generated client named routes nothing served.
 * Group/version/plural may be `static final String` constants of the file.
 */
const HALO_DEFAULT_GROUP_VERSION = "api.console.halo.run/v1alpha1";

function constantsOf(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/\bstatic\s+final\s+String\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]*)"/g)) out.set(m[1]!, m[2]!);
  for (const m of source.matchAll(/\bconst\s+val\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]*)"/g)) out.set(m[1]!, m[2]!);
  return out;
}

/** An argument's value — a literal or a constant of the file — or, for another class's constant, its reference. */
function argValue(args: string, name: string, constants: Map<string, string>): { value: string } | { ref: string } | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|([A-Za-z_][\\w.]*))`).exec(args);
  if (!m) return null;
  if (m[1] !== undefined) return { value: m[1] };
  const own = !m[2]!.includes(".") || /^[a-z]/.test(m[2]!) ? constants.get(m[2]!.split(".").pop()!) : undefined;
  return own !== undefined ? { value: own } : m[2]!.includes(".") ? { ref: m[2]! } : null;
}

/** A `@GVK` whose group, version or plural is another class's constant (`Constant.GROUP`): read by {@link haloGvkResolver}. */
export const HALO_GVK_FACT = "java:halo-gvk";
type GvkArg = { value: string } | { ref: string };
interface GvkFact { cls: string | null; group: GvkArg; version: GvkArg; plural: GvkArg; routed: boolean }

function crudRoutes(group: string, version: string, plural: string, line: number): RouteInfo[] {
  const collection = `${apiBase(group, version)}/${plural}`;
  const member = `${collection}/{name}`;
  return ([["GET", collection], ["POST", collection], ["GET", member], ["PUT", member], ["PATCH", member], ["DELETE", member]] as const).map(
    ([verb, path]) => ({ path, httpMethod: verb, kind: "api" as const, handler: null, calls: [], middleware: [], line }),
  );
}

/** What each generated CRUD route does to the stored extension. */
const CRUD_VERBS: Record<string, string> = { GET: "get", POST: "create", PUT: "update", PATCH: "patch", DELETE: "delete" };

/**
 * The generated routes have no handler function: each reads or writes the extension class itself
 * (stored through the extension client), so the access is stated on the route's own anchor.
 */
function storeAccesses(a: FileAnalysis, cls: string, routes: RouteInfo[]): void {
  for (const r of routes) {
    const handler = `route:${r.httpMethod} ${r.path}`;
    if (a.dataSources.some((d) => d.handler === handler)) continue;
    const verb = r.httpMethod === "GET" && !r.path.endsWith("/{name}") ? "list" : CRUD_VERBS[r.httpMethod!]!;
    a.dataSources.push({
      kind: "database", name: `extension: ${verb}`, target: null, entity: cls,
      access: r.httpMethod === "GET" ? "read" : "write", line: r.line, handler, calls: [],
    });
  }
}

const apiBase = (group: string, version: string): string => (group ? `/apis/${group}/${version}` : `/api/${version}`);

export function extractHaloExtensionRoutes(source: string, routes: RouteInfo[], facts?: RouteFact[]): void {
  if (!source.includes("@GVK(")) return;
  const constants = constantsOf(source);
  for (const m of source.matchAll(/@GVK\s*\(([^)]*)\)/g)) {
    const args = m[1]!;
    const group = argValue(args, "group", constants);
    const version = argValue(args, "version", constants);
    const plural = argValue(args, "plural", constants);
    if (!group || !version || !plural) continue;
    const line = source.slice(0, m.index).split("\n").length;
    const cls = /\bclass\s+(\w+)/.exec(source.slice(m.index! + m[0].length))?.[1] ?? null;
    const routed = "value" in group && "value" in version && "value" in plural;
    if (routed && version.value && plural.value) routes.push(...crudRoutes(group.value, version.value, plural.value, line));
    // Also for a routed one: a public query endpoint names the extension its `/apis/api.{group}` comes from.
    facts?.push({ kind: HALO_GVK_FACT, line, data: { cls, group, version, plural, routed } satisfies GvkFact });
  }
}

/** `@GVK(group = Constant.GROUP, version = Constant.VERSION, …)`: the constants read off the class the reference names. */
export const haloGvkResolver: RouteResolver = {
  id: "halo-gvk-constants",
  languages: ["java", "kotlin"],
  priority: 45,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    /** Java's package spans modules: `api/src/main/java/a/b` and `app/src/main/java/a/b` are one package. */
    const packageOf = (file: string) => /\/(?:java|kotlin)\/(.+)\/[^/]+$/.exec(file)?.[1] ?? null;
    const byPath = new Map(analyses.map((x) => [x.filePath, x]));
    /** The class a name means in a file: an explicit import first, then its own package, then the class index. */
    const classOf = (file: string, name: string) => {
      const imported = byPath.get(file)?.imports.some((i) => i.specifiers.includes(name));
      if (!imported) {
        const pkg = packageOf(file);
        const same = pkg ? analyses.filter((x) => packageOf(x.filePath) === pkg).flatMap((x) => x.classes.filter((c) => c.name === name)) : [];
        if (same.length === 1) return same[0]!;
      }
      return ctx.classes.resolve(file, name)?.cls ?? null;
    };
    /** Extension class → its group and version, for `PublicApiUtils.groupVersion(new X())`. */
    const gvkOf = new Map<string, Array<{ file: string; group: string; version: string }>>();
    for (const a of analyses) {
      const constant = (ref: string): string | null => {
        const dot = ref.lastIndexOf(".");
        return classOf(a.filePath, ref.slice(0, dot))?.fieldValues?.[ref.slice(dot + 1)] ?? null;
      };
      for (const fact of a.routeFacts ?? []) {
        if (fact.kind !== HALO_GVK_FACT) continue;
        const { cls, group, version, plural, routed } = fact.data as GvkFact;
        const read = (arg: GvkArg): string | null => ("value" in arg ? arg.value : constant(arg.ref));
        const [g, v, p] = [read(group), read(version), read(plural)];
        if (g === null || !v) continue;
        if (cls) (gvkOf.get(cls) ?? gvkOf.set(cls, []).get(cls)!).push({ file: a.filePath, group: g, version: v });
        if (!routed && p) a.routes.push(...crudRoutes(g, v, p, fact.line));
        if (cls && p) storeAccesses(a, cls, crudRoutes(g, v, p, fact.line));
      }
    }
    // A `CustomEndpoint` whose `groupVersion()` is computed: its routes wait for the prefix (see `customEndpointPrefixRef`).
    for (const a of analyses) {
      if (!a.routes.some((r) => r.prefixUnresolved?.startsWith(HALO_GV))) continue;
      const constant = (ref: string): string | null => {
        const dot = ref.lastIndexOf(".");
        if (dot < 0) return a.classes.map((c) => c.fieldValues?.[ref]).find((v) => v !== undefined) ?? null;
        return classOf(a.filePath, ref.slice(0, dot))?.fieldValues?.[ref.slice(dot + 1)] ?? null;
      };
      a.routes = a.routes.map((r) => {
        const expr = r.prefixUnresolved?.startsWith(HALO_GV) ? r.prefixUnresolved.slice(HALO_GV.length) : null;
        if (expr === null) return r;
        let gv: string | null = null;
        const ext = /^public:(\w+)$/.exec(expr);
        if (ext) {
          const cands = gvkOf.get(ext[1]!) ?? [];
          const one = cands.length === 1 ? cands[0]! : null;
          gv = one ? `api.${one.group || "halo.run"}/${one.version}` : null;
        } else {
          // `"console.api." + Constant.GROUP + "/" + Constant.VERSION`, `API_VERSION`
          const parts = expr.split("+").map((s) => s.trim());
          const values = parts.map((s) => (/^"[^"]*"$/.test(s) ? s.slice(1, -1) : /^[A-Za-z_][\w.]*$/.test(s) ? constant(s) : null));
          gv = values.every((v) => v !== null) ? values.join("") : null;
        }
        if (!gv) return r;
        const [g, v] = gv.includes("/") ? gv.split("/") : ["", gv];
        const { prefixUnresolved: _, ...rest } = r;
        return { ...rest, path: apiBase(g!, v!) + (r.path === "/" ? "" : r.path) };
      });
    }
  },
};

/** The `prefixUnresolved` mark of a Halo endpoint whose group version is computed. */
const HALO_GV = "halo-group-version:";

/**
 * A Halo `CustomEndpoint` whose `groupVersion()` is computed — `parseAPIVersion(API_VERSION)`,
 * `parseAPIVersion("console.api." + Constant.GROUP + "/" + Constant.VERSION)`,
 * `PublicApiUtils.groupVersion(new Category())` — as the `prefixUnresolved` its routes carry
 * until {@link haloGvkResolver} reads the constants. Null when the prefix is known or the class is none.
 */
export function customEndpointUnresolvedPrefix(classText: string): string | null {
  const body = /\bgroupVersion\s*\(\s*\)\s*\{([\s\S]{0,300}?)\}/.exec(classText)?.[1];
  if (!body) return null;
  const parsed = /parseAPIVersion\(\s*([^;]+?)\s*\)\s*;/.exec(body);
  if (parsed && !/^"[^"]*"$/.test(parsed[1]!)) return HALO_GV + parsed[1]!.replace(/\s+/g, " ");
  const ext = /\bgroupVersion\(\s*new\s+(\w+)\s*\(\s*\)\s*\)/.exec(body);
  return ext ? `${HALO_GV}public:${ext[1]}` : null;
}

/** The path prefix of a Halo `CustomEndpoint` class body, or null when the class is none. */
export function customEndpointPrefix(classText: string): string | null {
  if (customEndpointUnresolvedPrefix(classText)) return null;
  const declared = /\bgroupVersion\s*\(\s*\)[\s\S]{0,200}?(?:parseAPIVersion\(\s*"([^"]+)"\s*\)|new\s+GroupVersion\(\s*"([^"]*)"\s*,\s*"([^"]+)"\s*\))/.exec(classText);
  if (declared) {
    if (declared[1]) {
      const [g, v] = declared[1].includes("/") ? declared[1].split("/") : ["", declared[1]];
      return apiBase(g!, v!);
    }
    return apiBase(declared[2]!, declared[3]!);
  }
  if (!/\bimplements\b[^{]*\bCustomEndpoint\b/.test(classText.slice(0, classText.indexOf("{") + 1 || 400))) return null;
  const [g, v] = HALO_DEFAULT_GROUP_VERSION.split("/");
  return apiBase(g!, v!);
}
