import { azureHostJson, azureRouteBase } from "../shared/azure-functions.js";
import type { CallBaseRef, ProxyRule } from "../../../types/analysis.js";
import type { ConfigEntry, ConfigSourceSpec, ProxySourceSpec, ServiceConfigSpec } from "../../../types/language-plugin.js";
import { flattenStrings, lineOfPair, parseJsoncObject } from "../shared/jsonc.js";
import { isHttpTarget, templatePrefix } from "../shared/proxy-kit.js";

/**
 * How a .NET program is told where other services are: `appsettings*.json`
 * and `Properties/launchSettings.json`, read through `IConfiguration`, with
 * environment variables overriding keys by the `__` convention
 * (`Services__Orders` sets `Services:Orders`).
 *
 * Leaf module (the static manifest imports it): types and the JSONC kit only.
 */

/** `appsettings.Test.json`, `appsettings.IntegrationTests.json`: a test profile. */
const TEST_PROFILE = /test/i;

/** Keys that say where the app itself listens, not where it calls. */
const LISTEN_KEY = /^(?:urls|kestrel:endpoints:[^:]+:url)$/i;

/** `appsettings.json` and every `appsettings.<Environment>.json` beside it. */
const appsettings: ConfigSourceSpec = {
  files: ["appsettings.json", "appsettings.*.json"],
  glob: { deep: 1, limit: 12 },
  parse(text, path) {
    const obj = parseJsoncObject(text);
    if (!obj) return [];
    const m = /appsettings\.([^/.]+)\.json$/i.exec(path);
    const profile = m?.[1];
    return flattenStrings(obj, ":").flatMap(({ key, value }): ConfigEntry[] => {
      const line = lineOfPair(text, key.split(":").pop()!, value);
      const base: ConfigEntry = { key, value, ...(line ? { line } : {}), ...(profile ? { profile } : {}) };
      if (profile && TEST_PROFILE.test(profile)) base.test = true;
      // `Urls` holds several, `;`-separated.
      if (LISTEN_KEY.test(key)) return value.split(";").map((u) => ({ ...base, value: u.trim(), listen: true }));
      return [base];
    });
  },
};

/**
 * `Properties/launchSettings.json`: per profile, the URLs `dotnet run` binds
 * (`applicationUrl`, `;`-separated) and the environment it sets.
 */
const launchSettings: ConfigSourceSpec = {
  files: ["Properties/launchSettings.json"],
  parse(text) {
    const obj = parseJsoncObject(text);
    const profiles = obj?.profiles;
    if (!profiles || typeof profiles !== "object") return [];
    const out: ConfigEntry[] = [];
    for (const [profile, body] of Object.entries(profiles as Record<string, unknown>)) {
      if (!body || typeof body !== "object") continue;
      const p = body as Record<string, unknown>;
      const test = TEST_PROFILE.test(profile) || undefined;
      if (typeof p.applicationUrl === "string") {
        for (const url of p.applicationUrl.split(";")) {
          const value = url.trim();
          if (!value) continue;
          const line = lineOfPair(text, "applicationUrl", p.applicationUrl);
          out.push({ key: "applicationUrl", value, profile, listen: true, ...(line ? { line } : {}), ...(test ? { test } : {}) });
        }
      }
      const env = p.environmentVariables;
      if (env && typeof env === "object") {
        for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
          if (typeof value !== "string") continue;
          const line = lineOfPair(text, key, value);
          out.push({ key, value, profile, env: true, ...(line ? { line } : {}), ...(test ? { test } : {}) });
        }
      }
    }
    return out;
  },
};

/** A C# string literal's value (`"x"`, `@"x"`); null for anything else, interpolations included. */
function stringLiteral(text: string): string | null {
  const m = /^@?"((?:[^"\\]|\\.|"")*)"$/.exec(text.trim());
  return m ? m[1]!.replace(/""/g, '"') : null;
}

/**
 * Receivers that read like an `IConfiguration`: `_config`, `configuration`,
 * `builder.Configuration`, or one resolved from the container
 * (`sp.GetRequiredService<IConfiguration>()`).
 */
const CONFIG_RECEIVER = /(?:^|[._])(?:config|configuration|cfg)$|\.Get(?:Required)?Service\s*<\s*IConfiguration(?:Root)?\s*>\s*\(\s*\)$/i;

/**
 * What a .NET base expression reads:
 *   `new Uri(_config["Services:Orders"]!)`            → config Services:Orders
 *   `configuration.GetValue<string>("Services:Orders")` → config Services:Orders
 *   `_config.GetSection("Services")["Orders"]`         → config Services:Orders
 *   `Environment.GetEnvironmentVariable("ORDERS_URL")` → env ORDERS_URL
 *   `… ?? "http://localhost:5002"`                     → the same, with a fallback
 *   `"http://orders:8080"`                             → literal
 */
export function csharpBaseRefOf(expr: string): CallBaseRef | null {
  let s = expr.trim();
  // Unwrap what does not change the value: `new Uri(x)`, `(x)`, a trailing `!`.
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/!$/, "").trim();
    const uri = /^new\s+(?:System\.)?Uri\s*\(([\s\S]*)\)$/.exec(s);
    if (uri) s = uri[1]!.split(/,\s*UriKind\./)[0]!.trim();
    if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
  }
  // `a ?? "fallback"` / `a ?? throw …`
  const coalesce = /^([\s\S]+?)\s*\?\?\s*([\s\S]+)$/.exec(s);
  if (coalesce) {
    const ref = csharpBaseRefOf(coalesce[1]!);
    if (!ref) return null;
    const fallback = stringLiteral(coalesce[2]!);
    return fallback !== null && ref.kind !== "literal" ? { ...ref, fallback } : ref;
  }
  const lit = stringLiteral(s);
  if (lit !== null) return /^[a-z][a-z0-9+.-]*:\/\//i.test(lit) ? { kind: "literal", key: lit } : null;

  const env = /^(?:System\.)?Environment\.GetEnvironmentVariable\(\s*("[^"]*")\s*\)$/.exec(s);
  if (env) return { kind: "env", key: stringLiteral(env[1]!)! };

  // `cfg.GetSection("A")["B"]`, `cfg.GetSection("A").GetValue<string>("B")`, `cfg["A:B"]`, …
  const keys: string[] = [];
  let rest = s;
  for (;;) {
    const index = /\[\s*("[^"]*")\s*\]$/.exec(rest);
    const call = /\.(?:GetValue\s*<[^>]+>|GetSection|GetConnectionString)\s*\(\s*("[^"]*")\s*\)(?:\.Value)?$/.exec(rest);
    const m = index ?? call;
    if (!m) break;
    const key = stringLiteral(m[1]!)!;
    keys.unshift(/GetConnectionString/.test(m[0]) ? `ConnectionStrings:${key}` : key);
    rest = rest.slice(0, m.index).trim();
  }
  if (keys.length === 0 || !CONFIG_RECEIVER.test(rest)) return null;
  return { kind: "config", key: keys.join(":") };
}

const asMap = (v: unknown): Array<[string, Record<string, unknown>]> => {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x]).filter((e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === "object");
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).filter((e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === "object");
  return [];
};

/**
 * YARP's `ReverseProxy` section: each route's `Match.Path` forwards to every
 * destination address of its cluster, through the path transforms it lists
 * (`PathRemovePrefix`, `PathPrefix`, `PathPattern`, `PathSet`).
 */
const yarp: ProxySourceSpec = {
  files: ["appsettings.json", "appsettings.*.json"],
  glob: { deep: 1, limit: 12 },
  parse(text, path) {
    if (TEST_PROFILE.test(/appsettings\.([^/.]+)\.json$/i.exec(path)?.[1] ?? "")) return [];
    const proxy = parseJsoncObject(text)?.ReverseProxy;
    if (!proxy || typeof proxy !== "object") return [];
    const { Routes, Clusters } = proxy as Record<string, unknown>;
    const clusters = new Map(asMap(Clusters));
    const out: Array<Omit<ProxyRule, "file">> = [];
    for (const [, route] of asMap(Routes)) {
      const match = route.Match as Record<string, unknown> | undefined;
      const pattern = typeof match?.Path === "string" ? match.Path : "{**catch-all}";
      const pathPrefix = templatePrefix(pattern);
      let rewriteTo: string | undefined;
      for (const [, t] of asMap(route.Transforms)) {
        if (typeof t.PathRemovePrefix === "string") {
          const rp = t.PathRemovePrefix.replace(/\/+$/, "");
          if (pathPrefix === rp || pathPrefix.startsWith(rp + "/")) rewriteTo = pathPrefix.slice(rp.length);
        } else if (typeof t.PathPrefix === "string") rewriteTo = t.PathPrefix.replace(/\/+$/, "") + (rewriteTo ?? pathPrefix);
        else if (typeof t.PathPattern === "string") rewriteTo = templatePrefix(t.PathPattern);
        else if (typeof t.PathSet === "string") rewriteTo = templatePrefix(t.PathSet);
      }
      const cluster = typeof route.ClusterId === "string" ? clusters.get(route.ClusterId) : undefined;
      const line = typeof match?.Path === "string" ? lineOfPair(text, "Path", match.Path) : undefined;
      for (const [, dest] of asMap(cluster?.Destinations)) {
        const target = typeof dest.Address === "string" ? dest.Address : "";
        if (!isHttpTarget(target)) continue;
        out.push({ pathPrefix, target, ...(rewriteTo !== undefined ? { rewriteTo } : {}), via: "yarp", ...(line ? { line } : {}) });
      }
    }
    return out;
  },
};

/** Ocelot: `ocelot.json` `Routes` (`ReRoutes` before v16), upstream template → downstream host + template. */
const ocelot: ProxySourceSpec = {
  files: ["ocelot.json", "ocelot.*.json"],
  glob: { deep: 1, limit: 8 },
  parse(text, path) {
    if (TEST_PROFILE.test(/ocelot\.([^/.]+)\.json$/i.exec(path)?.[1] ?? "")) return [];
    const obj = parseJsoncObject(text);
    const out: Array<Omit<ProxyRule, "file">> = [];
    for (const [, r] of asMap(obj?.Routes ?? obj?.ReRoutes)) {
      if (typeof r.UpstreamPathTemplate !== "string" || typeof r.DownstreamPathTemplate !== "string") continue;
      const scheme = typeof r.DownstreamScheme === "string" ? r.DownstreamScheme : "http";
      const line = lineOfPair(text, "UpstreamPathTemplate", r.UpstreamPathTemplate);
      for (const [, hp] of asMap(r.DownstreamHostAndPorts)) {
        if (typeof hp.Host !== "string") continue;
        const target = `${scheme}://${hp.Host}${hp.Port !== undefined ? `:${hp.Port}` : ""}`;
        if (!isHttpTarget(target)) continue;
        out.push({
          pathPrefix: templatePrefix(r.UpstreamPathTemplate),
          target,
          rewriteTo: templatePrefix(r.DownstreamPathTemplate),
          via: "ocelot",
          ...(line ? { line } : {}),
        });
      }
    }
    return out;
  },
};

export const csharpServiceConfig: ServiceConfigSpec = {
  sources: [appsettings, launchSettings, azureHostJson],
  proxySources: [yarp, ocelot],
  // An Azure Functions app serves its HTTP triggers under host.json's route prefix.
  routeBaseOf: azureRouteBase,
  baseRefOf: csharpBaseRefOf,
  // .NET's environment provider maps `__` to the `:` key separator.
  envNamesFor: (key) => [key.replace(/:/g, "__")],
};
