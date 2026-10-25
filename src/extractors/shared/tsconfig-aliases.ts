import { readFileSync, existsSync } from "fs";
import { dirname, join, resolve, sep, posix } from "path";
import { stripJsonc } from "../plugins/shared/jsonc.js";
import { bundlerConfigsIn, readBundlerAliases } from "./bundler-aliases.js";

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
  /** One base config, or several (TypeScript 5.0+), applied in order. */
  extends?: string | string[];
  references?: Array<{ path?: string }>;
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

/**
 * `readTsconfigUnsafe`, never throwing: a config of a shape it does not expect
 * contributes no aliases rather than failing the analysis of every file under it.
 */
function readTsconfig(tsconfigPath: string, seen: Set<string>): Map<string, string> {
  try {
    return readTsconfigUnsafe(tsconfigPath, seen);
  } catch {
    return new Map();
  }
}

function readTsconfigUnsafe(tsconfigPath: string, seen: Set<string>): Map<string, string> {
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
  const bases = Array.isArray(parsed.extends) ? parsed.extends : parsed.extends ? [parsed.extends] : [];
  for (const base of bases) {
    if (typeof base !== "string" || !(base.startsWith(".") || base.startsWith("/"))) continue;
    let extendsPath = resolve(baseDir, base);
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
    if (!Array.isArray(targets) || typeof targets[0] !== "string") continue;
    const aliasPrefix = alias.replace(/\/?\*+$/, "");
    const targetBase = targets[0]!.replace(/\/?\*+$/, "");
    aliases.set(aliasPrefix, resolve(compilerBase, targetBase));
  }
  // A solution-style tsconfig (`"files": []` + `references`, every
  // create-vite/create-vue scaffold) keeps the app's `paths` in the configs
  // it references (`tsconfig.app.json`); their aliases fill what this one
  // does not declare.
  for (const ref of parsed.references ?? []) {
    if (typeof ref?.path !== "string") continue;
    let refPath = resolve(baseDir, ref.path);
    if (!/\.json$/i.test(refPath)) refPath = resolve(refPath, "tsconfig.json");
    if (!existsSync(refPath)) continue;
    for (const [k, v] of readTsconfig(refPath, seen)) if (!aliases.has(k)) aliases.set(k, v);
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
    // The nearest directory that configures module resolution: a tsconfig
    // (else a jsconfig) and/or a bundler config. The bundler's aliases fill
    // what the tsconfig does not declare.
    const bundlers = bundlerConfigsIn(current);
    // A package with a bundler config but no tsconfig of its own still
    // compiles under the nearest one above it.
    const tsconfigPath = configIn(current) ?? (bundlers.length > 0 ? configAbove(current) : undefined);
    if (tsconfigPath || bundlers.length > 0) {
      let fromTs = new Map<string, string>();
      if (tsconfigPath) {
        const cached = tsconfigCache.get(tsconfigPath);
        fromTs = cached ?? readTsconfig(tsconfigPath, new Set());
        if (!cached) tsconfigCache.set(tsconfigPath, fromTs);
      }
      result = fromTs;
      if (bundlers.length > 0) {
        result = new Map(fromTs);
        for (const [k, v] of safeBundlerAliases(current)) if (!result.has(k)) result.set(k, v);
      }
      break;
    }
    const parent = dirname(current);
    if (parent === current) { result = new Map(); break; }
    current = parent;
  }
  for (const dir of visited) dirAliasCache.set(dir, result);
  return result;
}

/** `readBundlerAliases`, never throwing (a config is code; an unexpected shape yields nothing). */
function safeBundlerAliases(dir: string): Map<string, string> {
  try {
    return readBundlerAliases(dir);
  } catch {
    return new Map();
  }
}

/** The tsconfig (else jsconfig) of `dir`. */
function configIn(dir: string): string | undefined {
  return [resolve(dir, "tsconfig.json"), resolve(dir, "jsconfig.json")].find((p) => existsSync(p));
}

/** The nearest tsconfig/jsconfig strictly above `dir`. */
function configAbove(dir: string): string | undefined {
  for (let current = dirname(dir); ; current = dirname(current)) {
    const hit = configIn(current);
    if (hit) return hit;
    if (dirname(current) === current) return undefined;
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
    if (prefix === BASE_URL_KEY) continue;
    if (importSource === prefix || importSource.startsWith(prefix + "/")) {
      const rest = importSource.slice(prefix.length).replace(/^\/+/, "");
      const abs = sourceOfBuilt(resolve(base, rest));
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

/**
 * An alias into a workspace package's build output (`packages/club-client/dist/index`), which the
 * tree does not hold: the source module the build starts from — the same path under `src/` or
 * `entry/`, or beside `package.json`. The path itself when it exists or no source is found.
 */
function sourceOfBuilt(abs: string): string {
  const built = /^(.*)[\\/](?:dist|build|lib|out)[\\/](.+)$/.exec(abs);
  if (!built || BASE_URL_EXTENSIONS.some((ext) => existsSync(abs + ext)) || !existsSync(join(built[1]!, "package.json"))) return abs;
  const rest = built[2]!.replace(/\.(?:d\.ts|m?js|cjs)$/, "");
  // The main bundle: the one entry the package's bundler config names (`entry: ["./entry/index.ts"]`).
  if (rest === "index") {
    for (const name of ["vite.config", "tsdown.config", "tsup.config"]) {
      for (const ext of [".ts", ".mts", ".js", ".mjs"]) {
        const config = join(built[1]!, name + ext);
        if (!existsSync(config)) continue;
        let text = "";
        try { text = readFileSync(config, "utf-8"); } catch { /* unreadable config: no entry */ }
        const entries = [...text.matchAll(/\bentry\s*:\s*\[?\s*["'`]([^"'`]+)["'`]\s*\]?/g)].map((m) => m[1]!);
        const entry = entries.length > 0 && entries.every((e) => e === entries[0]) ? join(built[1]!, entries[0]!) : null;
        if (entry && existsSync(entry)) return entry.replace(/\.(?:tsx?|m?jsx?)$/, "");
      }
    }
  }
  for (const dir of ["src", "entry", ""]) {
    const cand = join(built[1]!, dir, rest);
    if (BASE_URL_EXTENSIONS.some((ext) => existsSync(cand + ext))) return cand;
  }
  return abs;
}

/** The alias-map key carrying a tsconfig's `baseUrl` directory. */
const BASE_URL_KEY = "<baseUrl>";
const BASE_URL_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", "/index.ts", "/index.js"];

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** A package directory's declared dependencies, by the directory of its `package.json` (null: none there). */
const packageDepsCache = new Map<string, Set<string> | null>();
function packageDepsAt(dir: string): Set<string> | null {
  let hit = packageDepsCache.get(dir);
  if (hit === undefined) {
    hit = null;
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8")) as Record<string, Record<string, string> | undefined>;
      hit = new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {})));
    } catch {
      /* no package.json here */
    }
    packageDepsCache.set(dir, hit);
  }
  return hit;
}

const SOURCE_ROOT_EXTENSIONS = [".js", ".ts", ".vue", ".jsx", ".tsx", ".mjs", ".svelte", "/index.js", "/index.ts"];

/**
 * A bare import that names a module under its package's `src/` (`import { Rest } from "model/rest"`),
 * the root a bundler's resolver or `resolve.modules` adds without stating it as an alias: the file
 * there, when one exists and the first segment is no dependency the package declares. Unchanged otherwise.
 */
export function applySourceRoot(source: string, importerAbs: string, projectRoot: string): string {
  if (!/^[a-z][\w-]*\/[\w./-]+$/.test(source)) return source;
  const root = resolve(projectRoot);
  for (let dir = dirname(importerAbs); dir.startsWith(root); dir = dirname(dir)) {
    const deps = packageDepsAt(dir);
    if (deps) {
      if (deps.has(source.split("/")[0]!)) return source;
      const candidate = resolve(dir, "src", source);
      if (!SOURCE_ROOT_EXTENSIONS.some((ext) => existsSync(candidate + ext)) && !existsSync(candidate)) return source;
      return posix.relative(toPosix(root), toPosix(candidate));
    }
    if (dir === root) break;
  }
  return source;
}

/** `sourceRootStamp` by the package directory it reads, so sibling files share one. */
const sourceRootStampCache = new Map<string, string>();

/**
 * What `applySourceRoot` reads for an importer, as a stable string: the nearest
 * package directory with a `package.json`, relative to the project root, its
 * declared dependency names and its `imports` map. Equal stamps mean the
 * rewrite reads the same configuration (file existence aside).
 */
export function sourceRootStamp(importerAbs: string, projectRoot: string): string {
  const root = resolve(projectRoot);
  for (let dir = dirname(importerAbs); dir.startsWith(root); dir = dirname(dir)) {
    const deps = packageDepsAt(dir);
    if (deps) {
      let hit = sourceRootStampCache.get(dir);
      if (hit === undefined) {
        let imports: unknown = null;
        try {
          imports = (JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8")) as { imports?: unknown }).imports ?? null;
        } catch {
          /* unreadable: the deps above came from the same read, so it was readable then */
        }
        hit = JSON.stringify([posix.relative(toPosix(root), toPosix(dir)), [...deps].sort(), imports]);
        sourceRootStampCache.set(dir, hit);
      }
      return hit;
    }
    if (dir === root) break;
  }
  return "";
}

/** Reset every config read: each analysis run starts here, so a long-lived process sees an edited tsconfig. */
export function clearTsconfigAliasCache(): void {
  tsconfigCache.clear();
  dirAliasCache.clear();
  packageDepsCache.clear();
  sourceRootStampCache.clear();
}
