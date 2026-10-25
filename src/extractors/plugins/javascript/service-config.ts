import { azureHostJson, azureRouteBase } from "../shared/azure-functions.js";
import type { CallBaseRef, ProxyRule } from "../../../types/analysis.js";
import type { ProxySourceSpec, ServiceConfigSpec } from "../../../types/language-plugin.js";
import { lineOfPair, parseJsoncObject } from "../shared/jsonc.js";
import { isHttpTarget, nginxProxy, prefixOfPattern, rewritePrefix } from "../shared/proxy-kit.js";

/**
 * How a JS/TS program is told where other services are: environment
 * variables, read as `process.env.X` (Node), `import.meta.env.X` (Vite),
 * `Deno.env.get("X")` / `Bun.env.X`. `.env` files are never read — discovery
 * treats them as secrets — so a variable's value comes from the deployment
 * (compose, k8s) or the code's own fallback.
 *
 * Leaf module (the static manifest imports it): types and the shared kits only.
 */

function literal(text: string): string | null {
  const t = text.trim();
  const m = /^(['"`])([^'"`$\\]*)\1$/.exec(t);
  return m ? m[2]! : null;
}

/**
 * What a JS base expression reads:
 *   `process.env.ORDERS_URL`, `process.env["ORDERS_URL"]`, `import.meta.env.VITE_API`
 *                                     → env
 *   `… || "http://localhost:5101"`   → the same, with a fallback
 *   `"http://orders:8080"`            → literal
 */
export function jsBaseRefOf(expr: string): CallBaseRef | null {
  let s = expr.trim();
  while (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
  const or = /^([\s\S]+?)\s*(?:\|\||\?\?)\s*([\s\S]+)$/.exec(s);
  if (or) {
    const ref = jsBaseRefOf(or[1]!);
    if (!ref) return null;
    const fallback = literal(or[2]!);
    return fallback !== null && ref.kind !== "literal" ? { ...ref, fallback } : ref;
  }
  const lit = literal(s);
  if (lit !== null) return /^[a-z][a-z0-9+.-]*:\/\//i.test(lit) ? { kind: "literal", key: lit } : null;
  const env =
    /^(?:process\.env|import\.meta\.env|Bun\.env)(?:\?\.|\.)([A-Za-z_]\w*)$/.exec(s) ??
    /^(?:process\.env|import\.meta\.env|Bun\.env)\[\s*['"]([A-Za-z_]\w*)['"]\s*\]$/.exec(s) ??
    /^Deno\.env\.get\(\s*['"]([A-Za-z_]\w*)['"]\s*\)$/.exec(s);
  return env ? { kind: "env", key: env[1]! } : null;
}

/**
 * Angular CLI's `proxy.conf.json` (named by `angular.json` `proxyConfig`):
 * `{ "/api": { "target": "http://localhost:5000", "pathRewrite": { "^/api": "" } } }`,
 * or the array form with `context`.
 */
const angularProxy: ProxySourceSpec = {
  files: ["proxy.conf.json", "proxy.config.json", "src/proxy.conf.json", "src/proxy.config.json"],
  parse(text) {
    const obj = parseJsoncObject(text);
    if (!obj) return [];
    const out: Array<Omit<ProxyRule, "file">> = [];
    const add = (key: string, body: Record<string, unknown>) => {
      const pathPrefix = prefixOfPattern(key);
      const target = typeof body.target === "string" ? body.target : null;
      if (pathPrefix === null || !target || !isHttpTarget(target)) return;
      let rewriteTo: string | undefined;
      const rw = body.pathRewrite;
      if (rw && typeof rw === "object") {
        for (const [pattern, to] of Object.entries(rw as Record<string, unknown>)) {
          if (typeof to === "string") rewriteTo ??= rewritePrefix(pathPrefix, pattern, to);
        }
      }
      const line = lineOfPair(text, "target", target);
      out.push({ pathPrefix, target, ...(rewriteTo !== undefined ? { rewriteTo } : {}), via: "angular", ...(line ? { line } : {}) });
    };
    for (const [key, body] of Object.entries(obj)) {
      if (body && typeof body === "object" && !Array.isArray(body)) add(key, body as Record<string, unknown>);
    }
    return out;
  },
};

/** Create React App: `package.json` `"proxy": "http://localhost:4000"` forwards every API path. */
const craProxy: ProxySourceSpec = {
  files: ["package.json"],
  parse(text) {
    const proxy = parseJsoncObject(text)?.proxy;
    if (typeof proxy !== "string" || !isHttpTarget(proxy)) return [];
    const line = lineOfPair(text, "proxy", proxy);
    return [{ pathPrefix: "", target: proxy, via: "cra", ...(line ? { line } : {}) }];
  },
};

export const jsServiceConfig: ServiceConfigSpec = {
  // An Azure Functions app serves its HTTP triggers under host.json's route prefix.
  sources: [azureHostJson],
  routeBaseOf: azureRouteBase,
  baseRefOf: jsBaseRefOf,
  // nginx: the server an SPA's container runs, forwarding its API paths.
  proxySources: [angularProxy, craProxy, nginxProxy],
};
