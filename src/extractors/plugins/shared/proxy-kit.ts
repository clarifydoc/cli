import type { ProxyRule } from "../../../types/analysis.js";
import type { ProxySourceSpec } from "../../../types/language-plugin.js";

/**
 * Helpers for the plugins' forwarding-rule readers (dev proxies, gateways).
 * Leaf module: static manifests import it, so it may import nothing but types.
 */

/**
 * The literal path prefix a proxy key or rewrite pattern stands for:
 * `/api`, `^/api`, `^\/api`, `/api/*`, `/api/**`, `^/api/.*` → `/api`; `/` or `**` → "".
 * Null for a pattern that is not a plain prefix (alternation, classes, …).
 */
export function prefixOfPattern(pattern: string): string | null {
  let p = pattern.trim().replace(/^\^/, "").replace(/\\\//g, "/");
  // Trailing "anything": a glob `*`/`**` or a regex `.*`.
  p = p.replace(/\$$/, "").replace(/\/?(?:\.\*|\*\*?)$/, "");
  if (/[()[\]|+?*\\{}]/.test(p)) return null;
  if (p !== "" && !p.startsWith("/")) p = "/" + p;
  return p.replace(/\/+$/, "");
}

/**
 * The literal prefix of a gateway path template, up to its first parameter:
 * `/api/orders/{**catch-all}` → `/api/orders`, `{**catch-all}` → "",
 * `/orders/{id}` → `/orders`.
 */
export function templatePrefix(template: string): string {
  const literal = template.split("{")[0]!.trim();
  const p = literal.replace(/\/+$/, "");
  return p === "" || p.startsWith("/") ? p : "/" + p;
}

/**
 * A rewrite applied to a rule's prefix: `pattern` (as `prefixOfPattern` reads
 * it) replaced by `replacement` at the start of `pathPrefix`. Undefined when
 * the pattern does not apply to that prefix — the path is then kept.
 */
export function rewritePrefix(pathPrefix: string, pattern: string, replacement: string): string | undefined {
  const from = prefixOfPattern(pattern);
  if (from === null || !(pathPrefix === from || pathPrefix.startsWith(from + "/") || from === "")) return undefined;
  const to = (replacement + pathPrefix.slice(from.length)).replace(/\/{2,}/g, "/");
  return to === "/" ? "" : to.replace(/\/+$/, "");
}

/** An absolute http(s) address, the only proxy targets a route can sit behind. */
export function isHttpTarget(target: string): boolean {
  return /^https?:\/\/[^/\s]+/i.test(target.trim());
}

/**
 * nginx in front of an app (an SPA's container serving its build and passing
 * `/api/` on): `location /api/ { proxy_pass http://orders-api:8080; }`. A
 * `proxy_pass` naming an `upstream` forwards to its first `server`; one with
 * a URI part (`http://api/v1/`) replaces the matched location with it, as
 * nginx does. Regex and named locations, and targets built from nginx's own
 * runtime `$variables`, state no fixed rule and are skipped; an envsubst
 * template's `${VAR}` (the official image's `templates/*.template`) is kept
 * for core to fill from the image's environment.
 */
export const nginxProxy: ProxySourceSpec = {
  files: ["**/nginx.conf", "**/default.conf", "**/*.conf.template", "**/nginx/**/*.conf", "**/conf.d/*.conf"],
  glob: { deep: 3, limit: 10 },
  parse(text) {
    if (!text.includes("proxy_pass")) return [];
    const code = text.replace(/#[^\n]*/g, (c) => " ".repeat(c.length));
    const upstreams = new Map<string, string>();
    for (const m of code.matchAll(/\bupstream\s+([\w.-]+)\s*\{([^{}]*)\}/g)) {
      const server = /\bserver\s+([^\s;]+)/.exec(m[2]!)?.[1];
      if (server) upstreams.set(m[1]!, server);
    }
    const out: Array<Omit<ProxyRule, "file">> = [];
    for (const m of code.matchAll(/\blocation\s+(?:(=|\^~)\s*)?(\/[^\s{]*)\s*\{/g)) {
      const open = m.index! + m[0].length - 1;
      let depth = 0;
      let end = open;
      for (; end < code.length; end++) {
        if (code[end] === "{") depth++;
        else if (code[end] === "}" && --depth === 0) break;
      }
      const body = code.slice(open + 1, end);
      const pass = /(?:^|[\s;])proxy_pass\s+([^\s;]+)\s*;/.exec(body);
      if (!pass || /\$(?!\{)/.test(pass[1]!)) continue;
      const url = /^(https?):\/\/([^/]+)(\/.*)?$/.exec(pass[1]!);
      if (!url) continue;
      const host = upstreams.get(url[2]!) ?? url[2]!;
      const pathPrefix = prefixOfPattern(m[2]!);
      if (pathPrefix === null) continue;
      const rewriteTo = url[3] !== undefined ? rewritePrefix(pathPrefix, m[2]!, url[3]) : undefined;
      const line = code.slice(0, open + 1 + pass.index! + pass[0].indexOf("proxy_pass")).split("\n").length;
      out.push({ pathPrefix, target: `${url[1]}://${host}`, ...(rewriteTo !== undefined ? { rewriteTo } : {}), via: "nginx", line });
    }
    return out;
  },
};
