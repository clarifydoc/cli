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
