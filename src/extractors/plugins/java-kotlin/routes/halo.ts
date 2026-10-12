import type { RouteInfo } from "../../../../types/analysis.js";

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

function argValue(args: string, name: string, constants: Map<string, string>): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|([A-Za-z_][\\w.]*))`).exec(args);
  if (!m) return null;
  if (m[1] !== undefined) return m[1];
  return constants.get(m[2]!.split(".").pop()!) ?? null;
}

const apiBase = (group: string, version: string): string => (group ? `/apis/${group}/${version}` : `/api/${version}`);

export function extractHaloExtensionRoutes(source: string, routes: RouteInfo[]): void {
  if (!source.includes("@GVK(")) return;
  const constants = constantsOf(source);
  for (const m of source.matchAll(/@GVK\s*\(([^)]*)\)/g)) {
    const args = m[1]!;
    const group = argValue(args, "group", constants);
    const version = argValue(args, "version", constants);
    const plural = argValue(args, "plural", constants);
    if (group === null || !version || !plural) continue;
    const line = source.slice(0, m.index).split("\n").length;
    const collection = `${apiBase(group, version)}/${plural}`;
    const member = `${collection}/{name}`;
    for (const [verb, path] of [["GET", collection], ["POST", collection], ["GET", member], ["PUT", member], ["PATCH", member], ["DELETE", member]] as const) {
      routes.push({ path, httpMethod: verb, kind: "api", handler: null, calls: [], middleware: [], line });
    }
  }
}

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
