import { existsSync, readdirSync, readFileSync } from "fs";
import { join, posix, relative, resolve, sep } from "path";
import { clearDirectoryListings, rememberListing } from "./dir-listings.js";

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
 * `.ts`, else `src/index.ts` / `index.ts`. A name declared twice maps to
 * nothing: which one an import means depends on the installer.
 */

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", "out", "coverage", ".next", ".nuxt", ".svelte-kit", "vendor", "target"]);
const MAX_DEPTH = 5;
const cache = new Map<string, Map<string, WorkspacePackage>>();

export interface WorkspacePackage {
  /** Package directory, absolute. */
  dir: string;
  /** Source entry file, absolute — what `import … from 'name'` loads. */
  entry: string;
}

export function loadWorkspacePackages(projectRoot: string): Map<string, WorkspacePackage> {
  const root = resolve(projectRoot);
  const hit = cache.get(root);
  if (hit) return hit;
  const found = new Map<string, WorkspacePackage | null>();
  const walk = (dir: string, depth: number): void => {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    rememberListing(dir, entries.map((e) => e.name));
    if (dir !== root && entries.some((e) => e.isFile() && e.name === "package.json")) {
      const pkg = readPackage(join(dir, "package.json"));
      const entry = pkg?.name ? sourceEntry(dir, pkg) : null;
      if (pkg?.name && entry) found.set(pkg.name, found.has(pkg.name) ? null : { dir, entry });
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  const out = new Map<string, WorkspacePackage>();
  for (const [name, p] of found) if (p) out.set(name, p);
  cache.set(root, out);
  return out;
}

interface PackageJson {
  name?: string;
  source?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
}

function readPackage(path: string): PackageJson | null {
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return json && typeof json === "object" ? (json as PackageJson) : null;
  } catch {
    return null;
  }
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".svelte", ".vue"];

function sourceEntry(dir: string, pkg: PackageJson): string | null {
  const declared = [pkg.source, exportsEntry(pkg.exports), pkg.module, pkg.main, pkg.types ?? pkg.typings].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  for (const p of declared) {
    const abs = resolve(dir, p);
    if (/\.(?:[mc]?[jt]sx?|svelte|vue)$/.test(p) && !p.endsWith(".d.ts") && existsSync(abs) && !/(^|[\\/])(?:build|dist|out)[\\/]/.test(relative(dir, abs))) return abs;
    // Build output read back to its source: `./build/index.js` → `src/index.ts`.
    const asSource = p.replace(/^\.?\/?(?:build|dist|lib|out)\//, "src/").replace(/\.d\.ts$|\.[mc]?js$/, "");
    for (const ext of SOURCE_EXTENSIONS) {
      const candidate = resolve(dir, asSource + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const p of ["src/index", "index"]) {
    for (const ext of SOURCE_EXTENSIONS) {
      const candidate = resolve(dir, p + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** `exports: "./x.js"` or `exports: { ".": "./x.js" | { import, default, types } }`. */
function exportsEntry(exp: unknown): string | undefined {
  if (typeof exp === "string") return exp;
  if (!exp || typeof exp !== "object") return undefined;
  const dot = (exp as Record<string, unknown>)["."] ?? exp;
  if (typeof dot === "string") return dot;
  if (dot && typeof dot === "object") {
    const d = dot as Record<string, unknown>;
    for (const key of ["source", "import", "default", "require", "types"]) {
      const v = d[key];
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).default === "string") return (v as Record<string, string>).default;
    }
  }
  return undefined;
}

/**
 * `@league/sdk` → `packages/sdk/src/index` (project-relative, posix), for a
 * file outside that package; `@league/sdk/x` → the package directory + `x`.
 * Anything else comes back unchanged.
 */
export function applyWorkspacePackages(
  importSource: string,
  importingFile: string,
  packages: Map<string, WorkspacePackage>,
  projectRoot: string,
): string {
  if (packages.size === 0 || /^[./]/.test(importSource)) return importSource;
  for (const [name, pkg] of packages) {
    if (importSource !== name && !importSource.startsWith(name + "/")) continue;
    // A package importing itself by name means its own entry; leave that to its own resolver.
    if (resolve(importingFile).startsWith(pkg.dir + sep)) return importSource;
    const target = importSource === name ? pkg.entry : join(pkg.dir, importSource.slice(name.length + 1));
    const rel = relative(resolve(projectRoot), target).split(sep).join(posix.sep);
    // Extension-less, as a tsconfig alias rewrite is: every resolver adds the extensions.
    return rel.startsWith("..") ? importSource : rel.replace(/\.(?:[mc]?[jt]sx?|svelte|vue)$/, "");
  }
  return importSource;
}

/** Tests reset the per-root cache. */
export function clearWorkspacePackageCache(): void {
  cache.clear();
  clearDirectoryListings();
}
