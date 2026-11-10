import { existsSync, lstatSync, readFileSync } from "fs";
import { dirname, join, posix, relative, resolve, sep } from "path";
import { clearDirectoryListings, listEntries, rememberListing } from "./dir-listings.js";

/**
 * Packages of the repository itself, imported by name — a pnpm/npm/yarn
 * workspace's `import { getAlbum } from '@league/sdk'`. The name is bare, so
 * the import read as an external package and every call through it stopped at
 * the package boundary, though its source sits in `packages/sdk/src`.
 *
 * Each `package.json` with a `name` under the project root (not in
 * node_modules or build output) maps that name to its source entry: the
 * `source` field, else the `exports["."]` / `module` / `main` / `types` path
 * as written when it exists, else that path with its build directory
 * (`build/`, `dist/`, `lib/`, `out/`) read as `src/` and `.js`/`.d.ts` as
 * `.ts`, else `src/index.ts` / `index.ts`. A name declared twice is the one
 * package a workspace lists as a member (root `workspaces`, array or
 * `{ packages }`, or `pnpm-workspace.yaml`) — an `examples/` copy is not one;
 * with no single member it maps to nothing: which one an import means
 * depends on the installer.
 */

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", "out", "coverage", ".next", ".nuxt", ".svelte-kit", "vendor", "target"]);
const MAX_DEPTH = 5;
const cache = new Map<string, Map<string, WorkspacePackage>>();
/** Every named package's directory by root, with or without a source entry (a shared-config package holds only JSON). */
const dirCache = new Map<string, Map<string, string>>();
/** Every name a package.json under the root declares, the ambiguous ones too. */
const nameCache = new Map<string, Set<string>>();

export interface WorkspacePackage {
  /** Package directory, absolute. */
  dir: string;
  /** Source entry file, absolute — what `import … from 'name'` loads. */
  entry: string;
  /** What `require('name')` loads, when the `require` condition names another file than `entry`. */
  requireEntry?: string;
  /** The manifest's `exports` map, when it has subpaths (`"./standings"`, `"./rules/*"`). */
  exports?: Record<string, unknown>;
}

export function loadWorkspacePackages(projectRoot: string): Map<string, WorkspacePackage> {
  const root = resolve(projectRoot);
  const hit = cache.get(root);
  if (hit) return hit;
  const found = new Map<string, Array<{ dir: string; pkg: PackageJson }>>();
  /** Workspace roots and the member globs each lists, relative to it. */
  const workspaces: Array<{ dir: string; globs: string[] }> = [];
  const walk = (dir: string, depth: number): void => {
    let entries: import("fs").Dirent[];
    try {
      entries = listEntries(dir) as import("fs").Dirent[];
    } catch {
      return;
    }
    rememberListing(dir, entries.map((e) => e.name));
    const pkg = entries.some((e) => e.isFile() && e.name === "package.json") ? readPackage(join(dir, "package.json")) : null;
    const globs = [...workspaceGlobs(pkg), ...(entries.some((e) => e.isFile() && e.name === "pnpm-workspace.yaml") ? pnpmWorkspaceGlobs(join(dir, "pnpm-workspace.yaml")) : [])];
    if (globs.length > 0) workspaces.push({ dir, globs });
    if (dir !== root && pkg?.name) {
      const list = found.get(pkg.name) ?? found.set(pkg.name, []).get(pkg.name)!;
      list.push({ dir, pkg });
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  const isMember = (dir: string): boolean => workspaces.some((w) => {
    const rel = relative(w.dir, dir).split(sep).join("/");
    return !rel.startsWith("..") && rel !== "" && matchesWorkspace(rel, w.globs);
  });
  const out = new Map<string, WorkspacePackage>();
  const named = new Map<string, string>();
  for (const [name, list] of found) {
    // Declared twice: the one a workspace lists as its member.
    const members = list.length > 1 ? list.filter((c) => isMember(c.dir)) : list;
    if (members.length !== 1) continue;
    const { dir, pkg } = members[0]!;
    named.set(name, dir);
    const entry = sourceEntry(dir, pkg, false);
    if (!entry) continue;
    const requireEntry = sourceEntry(dir, pkg, true);
    const subpaths = exportsSubpaths(pkg.exports);
    out.set(name, { dir, entry, ...(requireEntry && requireEntry !== entry ? { requireEntry } : {}), ...(subpaths ? { exports: subpaths } : {}) });
  }
  cache.set(root, out);
  dirCache.set(root, named);
  nameCache.set(root, new Set(found.keys()));
  return out;
}

/**
 * Whether `importSource` names a package some `package.json` under the root
 * declares (`@league/kit`, `@league/kit/standings`), resolved to a member or
 * not: such an import names that package, never a file whose name it ends in.
 */
export function namesWorkspacePackage(projectRoot: string, importSource: string): boolean {
  const root = resolve(projectRoot);
  if (!nameCache.has(root)) {
    cache.delete(root);
    loadWorkspacePackages(root);
  }
  const names = nameCache.get(root)!;
  if (names.size === 0 || /^[./]/.test(importSource)) return false;
  const parts = importSource.split("/");
  return names.has(importSource.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!);
}

/** A root `package.json`'s `workspaces`: an array of globs, or `{ packages: [...] }` (Yarn). */
function workspaceGlobs(pkg: PackageJson | null): string[] {
  const ws = pkg?.workspaces;
  const list = Array.isArray(ws) ? ws : ws && typeof ws === "object" ? (ws as { packages?: unknown }).packages : undefined;
  return Array.isArray(list) ? list.filter((g): g is string => typeof g === "string") : [];
}

/** `pnpm-workspace.yaml`'s `packages:` list — the one key read, so a line scan, not a YAML parser. */
function pnpmWorkspaceGlobs(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) {
      inside = /^packages\s*:/.test(line);
      // `packages: ["a/*", "b"]` on one line.
      const flow = inside ? /\[(.*)\]/.exec(line)?.[1] : undefined;
      if (flow) for (const g of flow.split(",")) out.push(g.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const item = inside ? /^\s*-\s*(.+?)\s*$/.exec(line)?.[1] : undefined;
    if (item) out.push(item.replace(/^["']|["']$/g, ""));
  }
  return out.filter(Boolean);
}

/** A directory (relative to the workspace root) one of the globs includes and no `!` glob excludes. */
function matchesWorkspace(rel: string, globs: readonly string[]): boolean {
  let member = false;
  for (const g of globs) {
    const negated = g.startsWith("!");
    if (globRegex(negated ? g.slice(1) : g).test(rel)) {
      if (negated) return false;
      member = true;
    }
  }
  return member;
}

function globRegex(glob: string): RegExp {
  const body = glob
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .split("/")
    .map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
    .join("/")
    .replace(/\/\(\?:\.\*\)/g, "(?:/.*)?")
    .replace(/^\(\?:\.\*\)\//, "(?:.*/)?");
  return new RegExp(`^${body}$`);
}

/**
 * The directory of the workspace package named `name` under `projectRoot` (absolute), whether or
 * not it has a source entry — a shared tsconfig package holds only JSON. Undefined when no package,
 * or more than one, declares that name.
 */
export function workspacePackageDir(projectRoot: string, name: string): string | undefined {
  const root = resolve(projectRoot);
  if (!dirCache.has(root)) {
    cache.delete(root);
    loadWorkspacePackages(root);
  }
  return dirCache.get(root)?.get(name);
}

interface PackageJson {
  name?: string;
  source?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  workspaces?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

function readPackage(path: string): PackageJson | null {
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return json && typeof json === "object" ? (json as PackageJson) : null;
  } catch {
    return null;
  }
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".vue"];

/** A path a manifest names, as the source file it is: as written when it is source, else build output read back to `src/`. */
function asSourceFile(dir: string, p: string): string | null {
  const abs = resolve(dir, p);
  if (/\.(?:[mc]?[jt]sx?|svelte|vue)$/.test(p) && !p.endsWith(".d.ts") && existsSync(abs) && !/(^|[\\/])(?:build|dist|out)[\\/]/.test(relative(dir, abs))) return abs;
  // Build output read back to its source: `./build/index.js` → `src/index.ts`.
  const asSource = p.replace(/^\.?\/?(?:build|dist|lib|out)\//, "src/").replace(/\.d\.[mc]?ts$|\.[mc]?js$/, "");
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = resolve(dir, asSource + ext);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sourceEntry(dir: string, pkg: PackageJson, required: boolean): string | null {
  const fields = required ? [pkg.main, pkg.module] : [pkg.module, pkg.main];
  const declared = [pkg.source, exportsEntry(pkg.exports, required), ...fields, pkg.types ?? pkg.typings].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  for (const p of declared) {
    const hit = asSourceFile(dir, p);
    if (hit) return hit;
  }
  for (const p of ["src/index", "index"]) {
    for (const ext of SOURCE_EXTENSIONS) {
      const candidate = resolve(dir, p + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The conditions read, best first: a workspace's own `source` (what bundlers
 * of the monorepo load), then the import system's (`import`, or `require` for
 * a `require()`), `default`, the other system's, and `types` last (read back
 * to its source by `asSourceFile`).
 */
function conditionOrder(required: boolean): readonly string[] {
  return required ? ["source", "require", "default", "import", "types"] : ["source", "import", "default", "require", "types"];
}

/** A conditional export target (`"./x.js"`, `{ import: { types, default } }`, an array of fallbacks) → its path. */
function pickTarget(value: unknown, required: boolean): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = pickTarget(v, required);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const conditions = value as Record<string, unknown>;
  for (const key of conditionOrder(required)) {
    const hit = key in conditions ? pickTarget(conditions[key], required) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

/** `exports: "./x.js"`, `{ ".": … }`, or a conditions object standing for `"."`. */
function exportsEntry(exp: unknown, required: boolean): string | undefined {
  if (exp && typeof exp === "object" && !Array.isArray(exp)) {
    const map = exp as Record<string, unknown>;
    if (Object.keys(map).some((k) => k.startsWith("."))) return pickTarget(map["."], required);
  }
  return pickTarget(exp, required);
}

/** The `exports` map when it names subpaths besides `"."`. */
function exportsSubpaths(exp: unknown): Record<string, unknown> | undefined {
  if (!exp || typeof exp !== "object" || Array.isArray(exp)) return undefined;
  const keys = Object.keys(exp);
  return keys.some((k) => k.startsWith("./")) ? (exp as Record<string, unknown>) : undefined;
}

/**
 * The target `exports` maps `./sub` to: an exact key, else the `./prefix/*`
 * pattern with the longest prefix, its `*` replaced by what it matched.
 * Undefined when no key matches, or the match maps to `null` (excluded).
 */
function exportsTarget(exports: Record<string, unknown>, subpath: string, required: boolean): string | undefined {
  if (subpath in exports) return pickTarget(exports[subpath], required);
  let best: { key: string; star: string } | undefined;
  for (const key of Object.keys(exports)) {
    const star = key.indexOf("*");
    if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length - 1) continue;
    if (!best || prefix.length > best.key.indexOf("*")) best = { key, star: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  if (!best) return undefined;
  return pickTarget(exports[best.key], required)?.split("*").join(best.star);
}

/** A file or directory at `target`, or a source file at it once an extension is added. */
function existsAsModule(target: string): boolean {
  return existsSync(target) || SOURCE_EXTENSIONS.some((ext) => existsSync(target + ext));
}

/** How a manifest pins a dependency to a workspace member rather than a registry version. */
const LINKED_SPEC = /^(?:workspace|file|link|portal):/;
const installedMemo = new Map<string, boolean>();

/**
 * The importer's own package pins `name` to a registry version (`"^1.2.0"`,
 * not `workspace:*`) and the installer put a real directory — not a link
 * into the workspace — at the nearest `node_modules/<name>`: the import loads
 * that installed copy, not the workspace member.
 */
function keepsInstalled(importingFile: string, name: string, root: string): boolean {
  const from = dirname(resolve(importingFile));
  const key = `${from}\0${name}`;
  const memo = installedMemo.get(key);
  if (memo !== undefined) return memo;
  let pinned = false;
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = existsSync(join(dir, "package.json")) ? readPackage(join(dir, "package.json")) : null;
    if (pkg) {
      const spec = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies].map((d) => d?.[name]).find((v) => v !== undefined);
      pinned = typeof spec === "string" && !LINKED_SPEC.test(spec.trim());
      break;
    }
    if (dir === root || !dir.startsWith(root) || dirname(dir) === dir) break;
  }
  let installed = false;
  if (pinned) {
    for (let dir = from; ; dir = dirname(dir)) {
      try {
        const stat = lstatSync(join(dir, "node_modules", name));
        installed = stat.isDirectory() && !stat.isSymbolicLink();
        break;
      } catch {
        /* not installed here: look further up */
      }
      if (dir === root || !dir.startsWith(root) || dirname(dir) === dir) break;
    }
  }
  installedMemo.set(key, installed);
  return installed;
}

/**
 * `@league/sdk` → `packages/sdk/src/index` (project-relative, posix), for a
 * file outside that package; `@league/sdk/x` → what the package's `exports`
 * map names for `./x`, else the package directory + `x`. `required`: the
 * import is a `require()`, which reads the `require` condition first. An
 * importer whose own package pins the name to a registry version installed
 * as a real directory keeps the installed package; a subpath naming nothing
 * in the package stays as written. Anything else comes back unchanged.
 */
export function applyWorkspacePackages(
  importSource: string,
  importingFile: string,
  packages: Map<string, WorkspacePackage>,
  projectRoot: string,
  required = false,
): string {
  if (packages.size === 0 || /^[./]/.test(importSource)) return importSource;
  for (const [name, pkg] of packages) {
    if (importSource !== name && !importSource.startsWith(name + "/")) continue;
    // A package importing itself by name means its own entry; leave that to its own resolver.
    if (resolve(importingFile).startsWith(pkg.dir + sep)) return importSource;
    const root = resolve(projectRoot);
    if (keepsInstalled(importingFile, name, root)) return importSource;
    let target: string | undefined;
    if (importSource === name) target = (required && pkg.requireEntry) || pkg.entry;
    else {
      const sub = importSource.slice(name.length + 1);
      const mapped = pkg.exports ? exportsTarget(pkg.exports, `./${sub}`, required) : undefined;
      target = (mapped && asSourceFile(pkg.dir, mapped)) ?? undefined;
      if (!target) {
        const joined = join(pkg.dir, sub);
        target = existsAsModule(joined) ? joined : undefined;
      }
    }
    if (!target) return importSource;
    const rel = relative(root, target).split(sep).join(posix.sep);
    // Extension-less, as a tsconfig alias rewrite is: every resolver adds the extensions.
    return rel.startsWith("..") ? importSource : rel.replace(/\.(?:[mc]?[jt]sx?|svelte|vue)$/, "");
  }
  return importSource;
}

/** Tests reset the per-root cache. */
export function clearWorkspacePackageCache(): void {
  cache.clear();
  dirCache.clear();
  nameCache.clear();
  installedMemo.clear();
  clearDirectoryListings();
}
