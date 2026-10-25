import type { ConfigEntry, ConfigSourceSpec, RouteBase } from "../../../types/language-plugin.js";

/**
 * Azure Functions HTTP triggers, shared by the C#, JS/TS and Python readers: a function serves
 * `<routePrefix>/<route>`, where `route` defaults to the function's name and `routePrefix` is the
 * host's (`extensions.http.routePrefix` in host.json, `api` when unset; `""` for none). The readers
 * give `/<route>`; the prefix is the project's route base, read from host.json at the project root.
 */

/** `kits/{id}` → `/kits/{id}`; no route → `/<FunctionName>`. */
export function azureFunctionPath(route: string | null, functionName: string): string {
  const r = (route ?? functionName).trim().replace(/^\/+/, "");
  return `/${r}`;
}

/** `["get", "Post"]` → `["GET", "POST"]`, de-duplicated. */
export function azureMethods(verbs: readonly string[]): string[] {
  return [...new Set(verbs.map((v) => v.replace(/^.*\./, "").toUpperCase()))];
}

export const ROUTE_PREFIX_KEY = "extensions.http.routePrefix";

/**
 * host.json at a project root: its route prefix as one entry, `api` when the file says none
 * (the host's default). Only a host file — one with a `version` — is read.
 */
export const azureHostJson: ConfigSourceSpec = {
  files: ["host.json"],
  parse(text): ConfigEntry[] {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    if (!json || typeof json !== "object" || typeof (json as { version?: unknown }).version !== "string") return [];
    const prefix = (json as { extensions?: { http?: { routePrefix?: unknown } } }).extensions?.http?.routePrefix;
    if (prefix !== undefined && typeof prefix !== "string") return [];
    const line = prefix === undefined ? undefined : text.split("\n").findIndex((l) => l.includes("routePrefix")) + 1 || undefined;
    return [{ key: prefix === undefined ? `${ROUTE_PREFIX_KEY} (default)` : ROUTE_PREFIX_KEY, value: prefix ?? "api", ...(line ? { line } : {}) }];
  },
};

/** The route base host.json sets: `/api` by default, none for `""`. */
export function azureRouteBase(entries: ReadonlyArray<ConfigEntry & { file: string }>): RouteBase | null {
  const hits = entries.filter((e) => e.key.startsWith(ROUTE_PREFIX_KEY) && /(?:^|\/)host\.json$/.test(e.file));
  if (hits.length !== 1) return null;
  const hit = hits[0]!;
  const v = hit.value.trim().replace(/^\/+|\/+$/g, "");
  if (!v || !/^[\w.~-]+(?:\/[\w.~-]+)*$/.test(v)) return null;
  return { path: `/${v}`, key: hit.key, file: hit.file, ...(hit.line ? { line: hit.line } : {}) };
}
