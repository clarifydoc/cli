import { readFileSync, existsSync } from "fs";
import { dirname, resolve, sep, posix } from "path";
import { stripJsonc } from "../plugins/shared/jsonc.js";

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

// JSONC lives in the plugins' shared leaf so static manifests can use it too.
export { stripJsonc };

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
  // `baseUrl` alone makes every directory under it importable by bare path
  // (`import { environment } from 'src/environments/environment'`).
  if (parsed.compilerOptions?.baseUrl) aliases.set(BASE_URL_KEY, compilerBase);
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

/** Per-directory memo — sibling files share a dir, nested dirs share ancestors. */
const dirAliasCache = new Map<string, Map<string, string>>();

/**
 * Aliases of the tsconfig NEAREST to a file's directory. A monorepo defines
 * paths per sub-project (each SPA its own `@src/*`, `@queries/*`, …) and the
 * repo root often has NO tsconfig at all — resolving only the root left every
 * aliased import in such sub-projects unresolved (whole SPAs with zero symbol
 * links). Prefix collisions across sub-projects (`@src` in two SPAs) also make
 * a merged global map wrong; nearest-wins is the compiler's own rule.
 *
 * The upward walk caches EVERY directory it passes through (they all share the
 * same nearest tsconfig), so across a whole repo the stat cost is amortized to
 * one visit per unique directory instead of one walk per file.
 */
export function loadTsconfigAliasesForDir(startDir: string): Map<string, string> {
  const visited: string[] = [];
  let current = resolve(startDir);
  let result: Map<string, string>;
  for (;;) {
    const hit = dirAliasCache.get(current);
    if (hit) { result = hit; break; }
    visited.push(current);
    const tsconfigPath = resolve(current, "tsconfig.json");
    if (existsSync(tsconfigPath)) {
      const cached = tsconfigCache.get(tsconfigPath);
      result = cached ?? readTsconfig(tsconfigPath, new Set());
      if (!cached) tsconfigCache.set(tsconfigPath, result);
      break;
    }
    const parent = dirname(current);
    if (parent === current) { result = new Map(); break; }
    current = parent;
  }
  for (const dir of visited) dirAliasCache.set(dir, result);
  return result;
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
    if (prefix === BASE_URL_KEY) continue;
    if (importSource === prefix || importSource.startsWith(prefix + "/")) {
      const rest = importSource.slice(prefix.length).replace(/^\/+/, "");
      const abs = resolve(base, rest);
      const rel = posix.relative(toPosix(resolve(projectRoot)), toPosix(abs));
      // Don't escape the project root — if rel starts with .., leave the original.
      if (rel.startsWith("..")) return importSource;
      return rel;
    }
  }
  // A bare path under `baseUrl` — only when a file is there, so a package
  // import (`rxjs/operators`) is never mistaken for one.
  const baseUrl = aliases.get(BASE_URL_KEY);
  if (baseUrl && importSource.includes("/") && !/^[./@]/.test(importSource)) {
    const abs = resolve(baseUrl, importSource);
    if (BASE_URL_EXTENSIONS.some((ext) => existsSync(abs + ext))) {
      const rel = posix.relative(toPosix(resolve(projectRoot)), toPosix(abs));
      if (!rel.startsWith("..")) return rel;
    }
  }
  return importSource;
}

/** The alias-map key carrying a tsconfig's `baseUrl` directory. */
const BASE_URL_KEY = "<baseUrl>";
const BASE_URL_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", "/index.ts", "/index.js"];

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Used by tests / fixture regeneration to reset the per-tsconfig cache. */
export function clearTsconfigAliasCache(): void {
  tsconfigCache.clear();
}
