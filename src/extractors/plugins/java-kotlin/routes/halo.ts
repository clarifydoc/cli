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
interface GvkFact { group: GvkArg; version: GvkArg; plural: GvkArg }

function crudRoutes(group: string, version: string, plural: string, line: number): RouteInfo[] {
  const collection = `${apiBase(group, version)}/${plural}`;
  const member = `${collection}/{name}`;
  return ([["GET", collection], ["POST", collection], ["GET", member], ["PUT", member], ["PATCH", member], ["DELETE", member]] as const).map(
    ([verb, path]) => ({ path, httpMethod: verb, kind: "api" as const, handler: null, calls: [], middleware: [], line }),
  );
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
    if ("value" in group && "value" in version && "value" in plural) {
      if (version.value && plural.value) routes.push(...crudRoutes(group.value, version.value, plural.value, line));
    } else facts?.push({ kind: HALO_GVK_FACT, line, data: { group, version, plural } satisfies GvkFact });
  }
}

/** `@GVK(group = Constant.GROUP, version = Constant.VERSION, …)`: the constants read off the class the reference names. */
export const haloGvkResolver: RouteResolver = {
  id: "halo-gvk-constants",
  languages: ["java", "kotlin"],
  priority: 45,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    for (const a of analyses) {
      for (const fact of a.routeFacts ?? []) {
        if (fact.kind !== HALO_GVK_FACT) continue;
        const { group, version, plural } = fact.data as GvkFact;
        const read = (arg: GvkArg): string | null => {
          if ("value" in arg) return arg.value;
          const dot = arg.ref.lastIndexOf(".");
          return ctx.classes.resolve(a.filePath, arg.ref.slice(0, dot))?.cls.fieldValues?.[arg.ref.slice(dot + 1)] ?? null;
        };
        const [g, v, p] = [read(group), read(version), read(plural)];
        if (g !== null && v && p) a.routes.push(...crudRoutes(g, v, p, fact.line));
      }
    }
  },
};

/** The path prefix of a Halo `CustomEndpoint` class body, or null when the class is none. */
export function customEndpointPrefix(classText: string): string | null {
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
