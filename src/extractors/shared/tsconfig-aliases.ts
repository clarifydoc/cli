import { readFileSync, existsSync } from "fs";
import { dirname, resolve, sep, posix } from "path";

/**
 * tsconfig.json path-alias resolution, ported from graphify-7
 * (extract.py:51-141).
 *
 *   - Hand-rolled JSONC strip (block + line comments, trailing commas)
 *   - Follows `extends` chains for relative/absolute paths only — npm-package
 *     extends (e.g. "@tsconfig/svelte/tsconfig.json") are skipped in v1
 *   - Per-tsconfig cache keyed by absolute path; circular extends are detected
 *
 * Output: a map of alias prefix → absolute filesystem directory. Callers feed
 * this into `applyAliases()` to rewrite import sources like `@/foo` → an
 * actual path on disk before the downstream resolver runs.
 */

const tsconfigCache = new Map<string, Map<string, string>>();

/**
 * Strip JSONC comments and trailing commas, preserving string literals.
 * Required because SvelteKit/NestJS/Vite/T3/Astro all ship JSONC tsconfigs.
 */
export function stripJsonc(text: string): string {
  // First pass: walk the string skipping over string-literal spans so // and
  // /* inside strings are preserved.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      // Copy the string verbatim, handling escapes.
      out += ch;
      i++;
      while (i < text.length) {
        const c = text[i]!;
        out += c;
        i++;
        if (c === "\\" && i < text.length) {
          out += text[i];
          i++;
        } else if (c === '"') {
          break;
        }
      }
    } else if (ch === "/" && text[i + 1] === "/") {
      // Line comment — skip to newline.
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      // Block comment — skip to terminator.
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  // Strip trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

interface RawTsconfig {
  extends?: string;
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

function readTsconfig(tsconfigPath: string, seen: Set<string>): Map<string, string> {
  if (seen.has(tsconfigPath)) return new Map(); // circular extends — bail
  seen.add(tsconfigPath);

  let parsed: RawTsconfig;
  try {
    const raw = readFileSync(tsconfigPath, "utf-8");
    try {
      parsed = JSON.parse(raw) as RawTsconfig;
    } catch {
      parsed = JSON.parse(stripJsonc(raw)) as RawTsconfig;
    }
  } catch {
    return new Map();
  }

  const baseDir = dirname(tsconfigPath);
  const aliases = new Map<string, string>();

  // Follow `extends` for relative/absolute paths only — skip npm-package extends.
  if (parsed.extends && (parsed.extends.startsWith(".") || parsed.extends.startsWith("/"))) {
    let extendsPath = resolve(baseDir, parsed.extends);
    if (!/\.[a-z]+$/i.test(extendsPath)) extendsPath += ".json";
    if (existsSync(extendsPath)) {
      for (const [k, v] of readTsconfig(extendsPath, seen)) aliases.set(k, v);
    }
  }

  const compilerBase = parsed.compilerOptions?.baseUrl
    ? resolve(baseDir, parsed.compilerOptions.baseUrl)
    : baseDir;
  const paths = parsed.compilerOptions?.paths ?? {};
  for (const [alias, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const aliasPrefix = alias.replace(/\/?\*+$/, "");
    const targetBase = targets[0]!.replace(/\/?\*+$/, "");
    aliases.set(aliasPrefix, resolve(compilerBase, targetBase));
  }
  return aliases;
}

/**
 * Walk up from `startDir` looking for tsconfig.json. Returns the merged alias
 * map (with extends chain folded in). Caches by absolute tsconfig path.
 */
export function loadTsconfigAliases(startDir: string): Map<string, string> {
  let current = resolve(startDir);
  while (true) {
    const tsconfigPath = resolve(current, "tsconfig.json");
    if (existsSync(tsconfigPath)) {
      const cached = tsconfigCache.get(tsconfigPath);
      if (cached) return cached;
      const aliases = readTsconfig(tsconfigPath, new Set());
      tsconfigCache.set(tsconfigPath, aliases);
      return aliases;
    }
    const parent = dirname(current);
    if (parent === current) return new Map();
    current = parent;
  }
}

/**
 * If `importSource` matches a known alias prefix, return the rewritten path
 * (POSIX, relative to `projectRoot`). Otherwise return the input unchanged.
 *
 *   loadTsconfigAliases → { "@" → "/proj/src" }
 *   applyAliases("@/foo/bar", aliases, "/proj") → "src/foo/bar"
 */
export function applyAliases(
  importSource: string,
  aliases: Map<string, string>,
  projectRoot: string,
): string {
  if (aliases.size === 0) return importSource;
  for (const [prefix, base] of aliases) {
    if (importSource === prefix || importSource.startsWith(prefix + "/")) {
      const rest = importSource.slice(prefix.length).replace(/^\/+/, "");
      const abs = resolve(base, rest);
      const rel = posix.relative(toPosix(resolve(projectRoot)), toPosix(abs));
      // Don't escape the project root — if rel starts with .., leave the original.
      if (rel.startsWith("..")) return importSource;
      return rel;
    }
  }
  return importSource;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Used by tests / fixture regeneration to reset the per-tsconfig cache. */
export function clearTsconfigAliasCache(): void {
  tsconfigCache.clear();
}
