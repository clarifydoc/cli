import { readFileSync, existsSync, statSync } from "fs";
import { clearDirectoryListings } from "./dir-listings.js";
import { dirname, isAbsolute, join, resolve, sep, posix } from "path";
import { workspacePackageDir } from "./workspace-packages.js";
import { stripJsonc } from "../plugins/shared/jsonc.js";
import { bundlerConfigsIn, readBundlerAliases } from "./bundler-aliases.js";

/**
 * tsconfig.json path-alias resolution, ported from graphify-7
 * (extract.py:51-141).
 *
 *   - Hand-rolled JSONC strip (block + line comments, trailing commas)
 *   - Follows `extends` chains: relative/absolute paths, and a package's config
 *     (`@garage/tsconfig/app.json`) through `node_modules` or the workspace
 *     package of that name; `${configDir}` is the directory of the config
 *     being loaded, not of the base that writes it
 *   - Per-tsconfig cache keyed by absolute path; circular extends are detected
 *
 * Output: an `AliasMap`. A tsconfig `paths` entry is kept as TypeScript reads
 * it — the pattern as written (`@/*`, `~ui/*.js`, an exact `@league/sdk`) →
 * its absolute target patterns, tried in order; a bundler alias is a prefix →
 * one absolute path. Callers feed this into `applyAliases()` to rewrite import
 * sources like `@/foo` → an actual path on disk before the downstream resolver runs.
 */

/** Import aliases: a tsconfig `paths` pattern → its target patterns (absolute), or a bundler prefix → one path. */
export type AliasMap = Map<string, string | string[]>;

const tsconfigCache = new Map<string, AliasMap>();

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
function readTsconfig(tsconfigPath: string, seen: Set<string>, configDir?: string): AliasMap {
  try {
    return readTsconfigUnsafe(tsconfigPath, seen, configDir ?? dirname(tsconfigPath));
  } catch {
    return new Map();
  }
}

/** `${configDir}` (TypeScript 5.5) → the directory of the config being loaded. */
function withConfigDir(path: string, configDir: string): string {
  return path.split("${configDir}").join(configDir);
}

function readTsconfigUnsafe(tsconfigPath: string, seen: Set<string>, configDir: string): AliasMap {
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
  const aliases: AliasMap = new Map();

  // A base config is read for the config being loaded: its `${configDir}` is this one's.
  const bases = Array.isArray(parsed.extends) ? parsed.extends : parsed.extends ? [parsed.extends] : [];
  for (const base of bases) {
    if (typeof base !== "string") continue;
    const extendsPath = extendsTarget(base, baseDir);
    if (extendsPath) {
      for (const [k, v] of readTsconfig(extendsPath, seen, configDir)) aliases.set(k, v);
    }
  }

  const compilerBase = parsed.compilerOptions?.baseUrl
    ? resolve(baseDir, withConfigDir(parsed.compilerOptions.baseUrl, configDir))
    : baseDir;
  // `baseUrl` alone makes every directory under it importable by bare path
  // (`import { environment } from 'src/environments/environment'`).
  if (parsed.compilerOptions?.baseUrl) aliases.set(BASE_URL_KEY, compilerBase);
  const paths = parsed.compilerOptions?.paths ?? {};
  for (const [alias, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    // TypeScript refuses a pattern or target with more than one `*`.
    if (starCount(alias) > 1) continue;
    const written = targets.filter((t): t is string => typeof t === "string" && starCount(t) <= 1);
    if (written.length === 0) continue;
    aliases.set(alias, written.map((t) => resolve(compilerBase, withConfigDir(t, configDir))));
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

function starCount(s: string): number {
  return s.split("*").length - 1;
}

/**
 * The file an `extends` names: a path relative to the config, or a package's
 * config (`@garage/tsconfig/app.json`, `@garage/tsconfig` = its `tsconfig.json`)
 * read from the nearest `node_modules` holding it, else from the workspace
 * package of that name. Undefined when none is there.
 */
function extendsTarget(base: string, baseDir: string): string | undefined {
  const withJson = (p: string) => (/\.[a-z]+$/i.test(p) ? p : p + ".json");
  if (base.startsWith(".") || isAbsolute(base)) {
    const p = withJson(resolve(baseDir, base));
    return existsSync(p) ? p : undefined;
  }
  const m = /^((?:@[^/]+\/)?[^/@][^/]*)(?:\/(.+))?$/.exec(base);
  if (!m) return undefined;
  const [, name, sub] = m;
  const inPackage = (dir: string): string | undefined => {
    const candidates = sub ? [withJson(join(dir, sub)), join(dir, sub, "tsconfig.json")] : [join(dir, "tsconfig.json")];
    return candidates.find((c) => existsSync(c));
  };
  let workspaceRoot: string | undefined;
  for (let dir = baseDir; ; dir = dirname(dir)) {
    const installed = join(dir, "node_modules", name!);
    if (existsSync(installed)) {
      const hit = inPackage(installed);
      if (hit) return hit;
    }
    if (!workspaceRoot && isWorkspaceRoot(dir)) workspaceRoot = dir;
    if (dirname(dir) === dir) break;
  }
  if (!workspaceRoot) return undefined;
  const pkgDir = workspacePackageDir(workspaceRoot, name!);
  return pkgDir ? inPackage(pkgDir) : undefined;
}

/** A directory that declares a package workspace: pnpm's, npm/yarn `workspaces`, lerna, nx, turbo. */
function isWorkspaceRoot(dir: string): boolean {
  if (["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json"].some((f) => existsSync(join(dir, f)))) return true;
  try {
    return "workspaces" in (JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as object);
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` looking for tsconfig.json. Returns the merged alias
 * map (with extends chain folded in). Caches by absolute tsconfig path.
 */
export function loadTsconfigAliases(startDir: string): AliasMap {
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
const dirAliasCache = new Map<string, AliasMap>();

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
export function loadTsconfigAliasesForDir(startDir: string): AliasMap {
  const visited: string[] = [];
  let current = resolve(startDir);
  let result: AliasMap;
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
      let fromTs: AliasMap = new Map();
      if (tsconfigPath) {
        const cached = tsconfigCache.get(tsconfigPath);
        fromTs = cached ?? readTsconfig(tsconfigPath, new Set());
        if (!cached) tsconfigCache.set(tsconfigPath, fromTs);
      }
      result = fromTs;
      if (bundlers.length > 0) {
        result = new Map(fromTs);
        // A key the tsconfig declares (`@` against its `@/*`) stays the tsconfig's.
        for (const [k, v] of safeBundlerAliases(current)) if (!result.has(k) && !result.has(`${k}/*`)) result.set(k, v);
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
 * If `importSource` matches a known alias, return the rewritten path (POSIX,
 * relative to `projectRoot`). Otherwise return the input unchanged.
 *
 *   loadTsconfigAliases → { "@/*" → ["/proj/src/*"] }
 *   applyAliases("@/foo/bar", aliases, "/proj") → "src/foo/bar"
 *
 * A tsconfig `paths` pattern is chosen as TypeScript chooses it: the pattern
 * equal to the import first, else the one with the longest prefix before its
 * `*` (whose suffix also matches); its targets are tried in order and the first
 * with a module there wins. Bundler aliases then apply in declaration order.
 */
export function applyAliases(
  importSource: string,
  aliases: AliasMap,
  projectRoot: string,
): string {
  if (aliases.size === 0) return importSource;
  const root = toPosix(resolve(projectRoot));
  const inProject = (abs: string): string | null => {
    const rel = posix.relative(root, toPosix(abs));
    // Don't escape the project root.
    return rel.startsWith("..") ? null : rel;
  };
  // `paths` never applies to a relative import.
  if (!/^\.{0,2}\//.test(importSource)) {
    const hit = bestPathPattern(importSource, aliases);
    if (hit) {
      const [pattern, targets, captured] = hit;
      const candidates = targets.map((t) => sourceOfBuilt(t.split("*").join(captured)));
      const found = candidates.find(isModuleAt);
      // No target holds a module: the first, as written, unless the pattern catches every
      // import (`"*"`), where a package import is far likelier than a missing project file.
      const chosen = found ?? (pattern === "*" ? undefined : candidates[0]);
      // An installed package (`"*": ["node_modules/*"]`) stays the package it names.
      if (chosen !== undefined) return /[\\/]node_modules[\\/]/.test(chosen) ? importSource : inProject(chosen) ?? importSource;
    }
  }
  for (const [prefix, base] of aliases) {
    if (prefix === BASE_URL_KEY || typeof base !== "string") continue;
    if (importSource === prefix || importSource.startsWith(prefix + "/")) {
      const rest = importSource.slice(prefix.length).replace(/^\/+/, "");
      return inProject(sourceOfBuilt(resolve(base, rest))) ?? importSource;
    }
  }
  // A bare path under `baseUrl` — only when a file is there, so a package
  // import (`rxjs/operators`) is never mistaken for one.
  const baseUrl = aliases.get(BASE_URL_KEY);
  if (typeof baseUrl === "string" && importSource.includes("/") && !/^[./@]/.test(importSource)) {
    const abs = resolve(baseUrl, importSource);
    if (BASE_URL_EXTENSIONS.some((ext) => existsSync(abs + ext))) {
      const rel = inProject(abs);
      if (rel !== null) return rel;
    }
  }
  return importSource;
}

/** The tsconfig `paths` pattern TypeScript picks for an import: [pattern, targets, what its `*` captured]. */
function bestPathPattern(importSource: string, aliases: AliasMap): [string, string[], string] | undefined {
  const exact = aliases.get(importSource);
  if (Array.isArray(exact) && !importSource.includes("*")) return [importSource, exact, ""];
  let best: [string, string[], string] | undefined;
  let bestPrefix = -1;
  for (const [pattern, targets] of aliases) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (prefix.length <= bestPrefix) continue;
    if (importSource.length < prefix.length + suffix.length || !importSource.startsWith(prefix) || !importSource.endsWith(suffix)) continue;
    bestPrefix = prefix.length;
    best = [pattern, targets, importSource.slice(prefix.length, importSource.length - suffix.length)];
  }
  return best;
}

const MODULE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json"];

/** Whether a module resolves at `abs`: the file itself, with an extension, a `.js` written for its `.ts`, or a directory's index. */
function isModuleAt(abs: string): boolean {
  if (isFile(abs)) return true;
  if (MODULE_EXTENSIONS.some((ext) => isFile(abs + ext))) return true;
  const js = /\.([mc]?)jsx?$/.exec(abs);
  if (js && [`.${js[1]}ts`, ".tsx"].some((ext) => isFile(abs.slice(0, -js[0].length) + ext))) return true;
  return MODULE_EXTENSIONS.some((ext) => isFile(join(abs, "index" + ext)));
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * An alias into a workspace package's build output (`packages/club-client/dist/index`), which the
 * tree does not hold: the source module the build starts from — the same path under `src/` or
 * `entry/`, or beside `package.json`. The path itself when it exists or no source is found.
 */
function sourceOfBuilt(abs: string): string {
  // The last build directory with a path below it: the package root before it, the module after.
  const out = [...abs.matchAll(/[\\/](?:dist|build|lib|out)(?=[\\/].)/g)].pop();
  const pkg = out ? abs.slice(0, out.index) : "";
  if (!out || BASE_URL_EXTENSIONS.some((ext) => existsSync(abs + ext)) || !existsSync(join(pkg, "package.json"))) return abs;
  const rest = abs.slice(out.index! + out[0].length + 1).replace(/\.(?:d\.ts|m?js|cjs)$/, "");
  // The main bundle: the one entry the package's bundler config names (`entry: ["./entry/index.ts"]`).
  if (rest === "index") {
    for (const name of ["vite.config", "tsdown.config", "tsup.config"]) {
      for (const ext of [".ts", ".mts", ".js", ".mjs"]) {
        const config = join(pkg, name + ext);
        if (!existsSync(config)) continue;
        let text = "";
        try { text = readFileSync(config, "utf-8"); } catch { /* unreadable config: no entry */ }
        const entries = [...text.matchAll(/\bentry\s*:\s*\[?\s*["'`]([^"'`]+)["'`]\s*\]?/g)].map((m) => m[1]!);
        const entry = entries.length > 0 && entries.every((e) => e === entries[0]) ? join(pkg, entries[0]!) : null;
        if (entry && existsSync(entry)) return entry.replace(/\.(?:tsx?|m?jsx?)$/, "");
      }
    }
  }
  for (const dir of ["src", "entry", ""]) {
    const cand = join(pkg, dir, rest);
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
/** Nearest package.json `imports` map per directory (null: the nearest package.json declares none). */
const packageImportsCache = new Map<string, { dir: string; imports: Record<string, unknown> } | null>();

/** The `imports` field of the package.json nearest above `dir` — Node's package scope; null when it has none. */
function nearestPackageImports(dir: string): { dir: string; imports: Record<string, unknown> } | null {
  const visited: string[] = [];
  let current = resolve(dir);
  let result: { dir: string; imports: Record<string, unknown> } | null = null;
  for (;;) {
    const hit = packageImportsCache.get(current);
    if (hit !== undefined) { result = hit; break; }
    visited.push(current);
    const pkg = join(current, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf-8")) as { imports?: unknown };
        if (parsed.imports && typeof parsed.imports === "object" && !Array.isArray(parsed.imports)) result = { dir: current, imports: parsed.imports as Record<string, unknown> };
      } catch { /* unreadable package.json: no imports */ }
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const d of visited) packageImportsCache.set(d, result);
  return result;
}

/** Conditions read from a conditional target, source-leaning first. */
const IMPORT_CONDITIONS = ["source", "development", "import", "module", "node", "default", "require"];

function importTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) { const t = importTarget(v); if (t) return t; }
    return null;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const c of IMPORT_CONDITIONS) if (c in obj) { const t = importTarget(obj[c]); if (t) return t; }
  }
  return null;
}

/**
 * A package-internal import (`import { findClub } from "#db/clubs"`) through
 * the nearest package.json `imports` map — an exact key, else the `*` pattern
 * with the longest prefix — as a path relative to `projectRoot` (a build-output
 * target read back to its source as tsconfig aliases are), or the package it
 * names. The specifier unchanged when it is no `#` import or nothing maps it.
 */
export function applyPackageImports(source: string, importerAbs: string, projectRoot: string): string {
  if (!source.startsWith("#")) return source;
  const scope = nearestPackageImports(dirname(importerAbs));
  if (!scope) return source;
  let target: string | null = null;
  if (source in scope.imports) target = importTarget(scope.imports[source]);
  else {
    let best = -1;
    for (const [key, value] of Object.entries(scope.imports)) {
      const star = key.indexOf("*");
      if (star < 0) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (prefix.length <= best || !source.startsWith(prefix) || !source.endsWith(suffix) || source.length < prefix.length + suffix.length) continue;
      const t = importTarget(value);
      if (!t) continue;
      best = prefix.length;
      target = t.split("*").join(source.slice(prefix.length, source.length - suffix.length));
    }
  }
  if (!target) return source;
  if (!target.startsWith("./")) return target; // another package
  const abs = sourceOfBuilt(resolve(scope.dir, target).replace(/\.(?:d\.ts|m?js|cjs)$/, ""));
  const rel = posix.relative(toPosix(resolve(projectRoot)), toPosix(abs));
  return rel.startsWith("..") ? source : rel;
}

/** What the nearest package.json `imports` map says, for the incremental cache key ("" when none). */
export function packageImportsStamp(importerAbs: string): string {
  const scope = nearestPackageImports(dirname(importerAbs));
  return scope ? `${scope.dir}\0${JSON.stringify(scope.imports)}` : "";
}

export function clearTsconfigAliasCache(): void {
  clearDirectoryListings();
  packageImportsCache.clear();
  tsconfigCache.clear();
  dirAliasCache.clear();
  packageDepsCache.clear();
  sourceRootStampCache.clear();
}
