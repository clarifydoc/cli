import type { CallBaseRef } from "../../../types/analysis.js";
import type { ServiceConfigSpec } from "../../../types/language-plugin.js";

/**
 * How a JS/TS program is told where other services are: environment
 * variables, read as `process.env.X` (Node), `import.meta.env.X` (Vite),
 * `Deno.env.get("X")` / `Bun.env.X`. `.env` files are never read — discovery
 * treats them as secrets — so a variable's value comes from the deployment
 * (compose, k8s) or the code's own fallback.
 *
 * Leaf module (the static manifest imports it): types only.
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

export const jsServiceConfig: ServiceConfigSpec = {
  baseRefOf: jsBaseRefOf,
};
