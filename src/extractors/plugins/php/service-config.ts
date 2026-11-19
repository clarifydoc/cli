import type { CallBaseRef } from "../../../types/analysis.js";
import type { ConfigEntry, ConfigSourceSpec, ServiceConfigSpec } from "../../../types/language-plugin.js";

/**
 * How a PHP program is told where other services are: `config/*.php` files
 * that `return` nested arrays (Laravel's `config/services.php`), read in code
 * as `config('services.league.url')`, with `env('LEAGUE_API_URL', 'http://…')`
 * naming the variable that overrides the key. `.env` is never read.
 *
 * Leaf module (the static manifest imports it): types only.
 */

/** A PHP string literal at `at` (single or double quoted, no interpolation): [value, end]. */
function literalAt(text: string, at: number): [string, number] | null {
  const q = text[at];
  if (q !== "'" && q !== '"') return null;
  let out = "";
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length) { out += text[i + 1]; i++; continue; }
    if (c === q) return [out, i + 1];
    if (q === '"' && c === "$") return null;
    out += c;
  }
  return null;
}

/** The end of the value starting at `at`: the next top-level `,` or the closing bracket of the enclosing array. */
function skipValue(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const lit = literalAt(text, i);
      if (lit) { i = lit[1] - 1; continue; }
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") { if (depth === 0) return i; depth--; }
    else if (c === "," && depth === 0) return i;
  }
  return text.length;
}

/** Block and line comments blanked, newlines kept so offsets and lines stay. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:'"])(?:\/\/|#(?!\[))[^\n]*/g, (m, p: string) => p + " ".repeat(m.length - p.length));
}

/** Every `'a' => ['b' => 'value']` leaf of a returned array, its key dotted from its parents. */
function arrayEntries(text: string, prefix: string): ConfigEntry[] {
  const src = withoutComments(text);
  const out: ConfigEntry[] = [];
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  const array = (at: number, path: string[]): number => {
    let i = at;
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i]!)) i++;
      if (i >= src.length) return i;
      if (src[i] === "]" || src[i] === ")") return i + 1;
      const key = /^(?:'([^']*)'|"([^"$]*)")\s*=>\s*/.exec(src.slice(i, i + 200));
      const valueAt = key ? i + key[0].length : i;
      const name = key ? (key[1] ?? key[2]!) : null;
      const rest = src.slice(valueAt, valueAt + 12);
      const nested = /^(?:\[|array\s*\()/i.exec(rest);
      if (nested) {
        i = array(valueAt + nested[0].length, name === null ? path : [...path, name]);
        continue;
      }
      const end = skipValue(src, valueAt);
      if (name !== null) {
        const full = [...path, name].join(".");
        const lit = literalAt(src, valueAt);
        const env = /^(?:env|getenv)\s*\(\s*(?:'([^']*)'|"([^"]*)")\s*(?:,\s*([\s\S]*?))?\)\s*$/.exec(src.slice(valueAt, end).trim());
        if (lit && src.slice(lit[1], end).trim() === "") out.push({ key: full, value: lit[0], line: lineAt(valueAt) });
        else if (env) {
          const fb = env[3] ? literalAt(env[3].trim(), 0) : null;
          out.push({ key: full, value: fb ? fb[0] : "", line: lineAt(valueAt), envNames: [(env[1] ?? env[2])!] });
        }
      }
      i = end;
    }
  };
  const start = /\breturn\s*(\[|array\s*\()/i.exec(src);
  if (start) array(start.index + start[0].length, [prefix]);
  return out;
}

/** `config/*.php`: arrays a framework reads through `config('<file>.<key>')`. */
const configArrays: ConfigSourceSpec = {
  files: ["config/*.php"],
  glob: { deep: 2, limit: 24 },
  parse(text, path) {
    const base = /([^/]+)\.php$/.exec(path)?.[1];
    // `config/testing.php` and friends are test profiles.
    const test = base && /test/i.test(base) ? { test: true as const } : {};
    return base ? arrayEntries(text, base).map((e) => ({ ...e, ...test })) : [];
  },
};

/** A PHP string literal's value, or null. */
const literal = (s: string): string | null => {
  const m = /^(?:'([^']*)'|"([^"$]*)")$/.exec(s.trim());
  return m ? (m[1] ?? m[2]!) : null;
};

/**
 * What a PHP base expression reads:
 *   `config('services.league.url')`            → config services.league.url
 *   `config('services.league.url', 'http://…')` → the same, with a fallback
 *   `env('LEAGUE_API_URL', 'http://…')`         → env LEAGUE_API_URL, with a fallback
 *   `getenv('X')`, `$_ENV['X']`, `$_SERVER['X']` → env X
 *   `'http://league-api:8080'`                  → literal
 */
export function phpBaseRefOf(expr: string): CallBaseRef | null {
  const s = expr.trim().replace(/^\\/, "");
  const lit = literal(s);
  if (lit !== null) return /^[a-z][a-z0-9+.-]*:\/\//i.test(lit) ? { kind: "literal", key: lit } : null;
  const call = /^(config|env|getenv)\s*\(\s*('[^']*'|"[^"$]*")\s*(?:,\s*([\s\S]+?))?\s*\)$/.exec(s);
  if (call) {
    const key = literal(call[2]!)!;
    const fb = call[3] ? literal(call[3]) : null;
    const fallback = fb !== null && /^https?:\/\//i.test(fb) ? { fallback: fb } : {};
    return { kind: call[1] === "config" ? "config" : "env", key, ...fallback };
  }
  const global = /^\$_(?:ENV|SERVER)\s*\[\s*('[^']*'|"[^"$]*")\s*\]$/.exec(s);
  if (global) return { kind: "env", key: literal(global[1]!)! };
  return null;
}

export const phpServiceConfig: ServiceConfigSpec = {
  sources: [configArrays],
  baseRefOf: phpBaseRefOf,
};
