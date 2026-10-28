import { glob } from "./glob.js";
import { byOrdinal } from "./ordinal.js";
import { readdir, readFile } from "fs/promises";
import { join, posix, resolve } from "path";
import type { PackageEcosystem, SubProject, SubProjectKind } from "../types/analysis.js";
import { loadIgnorePatterns, isIgnored, ignoredDirectories } from "./clarifydoc-ignore.js";
import { PACKAGE_MANAGERS } from "../extractors/registry.js";
import type { SelfNameContext } from "../types/language-plugin.js";

/**
 * Sub-project detection.
 *
 * A repository may contain multiple independent projects (monorepo packages,
 * a Delphi client next to a .NET service, etc.). We detect them by looking
 * for well-known marker files (package.json, *.csproj, *.dpr, pom.xml, ...).
 *
 * A file is assigned to the INNERMOST enclosing project — so a file inside
 * `packages/api/src` belongs to `packages/api`, not the outer repo root.
 * Files with no enclosing marker fall back to the synthetic "root" project.
 */

const MARKER_GLOBS: { pattern: string; kind: SubProjectKind }[] = [
  { pattern: "**/package.json", kind: "node" },
  { pattern: "**/*.csproj", kind: "dotnet" },
  { pattern: "**/*.vbproj", kind: "dotnet" },
  { pattern: "**/*.fsproj", kind: "dotnet" },
  { pattern: "**/*.sln", kind: "dotnet" },
  { pattern: "**/*.dpr", kind: "delphi" },
  { pattern: "**/*.dpk", kind: "delphi" },
  { pattern: "**/*.dproj", kind: "delphi" },
  { pattern: "**/*.lpi", kind: "lazarus" },
  { pattern: "**/*.lpr", kind: "lazarus" },
  { pattern: "**/pom.xml", kind: "java-maven" },
  { pattern: "**/build.gradle", kind: "java-gradle" },
  { pattern: "**/build.gradle.kts", kind: "java-gradle" },
  { pattern: "**/Cargo.toml", kind: "rust" },
  { pattern: "**/go.mod", kind: "go" },
  { pattern: "**/pyproject.toml", kind: "python" },
  { pattern: "**/setup.py", kind: "python" },
  { pattern: "**/requirements.txt", kind: "python" },
  { pattern: "**/composer.json", kind: "php" },
  { pattern: "**/Gemfile", kind: "ruby" },
  { pattern: "**/Package.swift", kind: "swift" },
  { pattern: "**/pubspec.yaml", kind: "dart" },
  { pattern: "**/mix.exs", kind: "elixir" },
  // Only a CMakeLists.txt containing a project() call marks a project root —
  // most CMakeLists are per-directory source lists (add_subdirectory targets)
  // and treating them as markers would fragment the repo under innermost-wins.
  { pattern: "**/CMakeLists.txt", kind: "cmake" },
];

/** Whether a marker pattern (a file name or `*.ext` under any directory) names a file, given its lower-cased base name. */
function markerMatches(pattern: string, base: string): boolean {
  const name = pattern.slice(pattern.lastIndexOf("/") + 1).toLowerCase();
  return name.startsWith("*.") ? base.endsWith(name.slice(1)) && base.length > name.length - 1 : base === name;
}

const MARKER_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.git/**",
  "**/bin/**",
  "**/obj/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/vendor/**",
  "**/target/**",
  "**/Pods/**",
];

/**
 * Primary-kind priority: when a directory contains multiple marker kinds
 * (e.g. a .NET project with a `package.json` for frontend tooling), pick
 * the more specific one. `node` is last so repo-root `package.json` only
 * wins when nothing else applies.
 */
const KIND_PRIORITY: SubProjectKind[] = [
  "delphi",
  "lazarus",
  "dotnet",
  "dart",
  "elixir",
  "java-maven",
  "java-gradle",
  "rust",
  "go",
  "cmake",
  "python",
  "php",
  "ruby",
  "swift",
  "node",
];

/** Detect all sub-projects under `projectRoot` by scanning for marker files. */
export async function detectSubProjects(
  projectRoot: string,
): Promise<SubProject[]> {
  const root = resolve(projectRoot);
  // Ignored directories are not sub-projects: a vendored component library is
  // full of package/project files (77 of them under one Delphi repo's
  // `Library/`), and each one otherwise becomes its own scanned root.
  const ignorePatterns = loadIgnorePatterns(root);
  const prune = ignoredDirectories(root, ignorePatterns);

  const byDir = new Map<
    string,
    { kinds: Set<SubProjectKind>; markers: Set<string> }
  >();

  // One walk for every marker: each pattern is `**/<name>` or `**/*.<ext>`, matched case-insensitively.
  const found = await glob(MARKER_GLOBS.map((m) => m.pattern), {
    cwd: root,
    ignore: MARKER_IGNORE,
    absolute: false,
    dot: false,
    // Legacy Windows repos ship PROJECT.DPR / MAKEFILE-cased markers.
    caseSensitiveMatch: false,
    prune,
  });
  const matches = ignorePatterns.length === 0
    ? found
    : found.filter((rel) => !isIgnored(join(root, rel), root, ignorePatterns));
  for (const match of matches) {
    const norm = match.replace(/\\/g, "/");
    const lastSlash = norm.lastIndexOf("/");
    const dir = lastSlash >= 0 ? norm.slice(0, lastSlash) : "";
    const base = norm.slice(lastSlash + 1).toLowerCase();
    for (const { kind } of MARKER_GLOBS.filter((m) => markerMatches(m.pattern, base))) {
      if (kind === "cmake" && !(await isCmakeProjectRoot(root, match))) continue;
      let entry = byDir.get(dir);
      if (!entry) {
        entry = { kinds: new Set(), markers: new Set() };
        byDir.set(dir, entry);
      }
      entry.kinds.add(kind);
      entry.markers.add(norm);
    }
  }

  const subProjects: SubProject[] = [];
  for (const [dir, info] of byDir) {
    const primaryKind = pickPrimaryKind(info.kinds);
    const name = dir === "" ? "(root)" : dir.split("/").pop()!;
    subProjects.push({
      id: dir === "" ? "root" : slugify(dir),
      name,
      root: dir,
      kind: primaryKind,
      markers: [...info.markers].sort(),
    });
  }

  // Always provide a "root" fallback so files without any enclosing marker
  // have somewhere to live. If the repo root already has a marker, the
  // fallback is not needed — assignProjectId will find the real project.
  if (!subProjects.some((p) => p.id === "root")) {
    subProjects.push({
      id: "root",
      name: "(root)",
      root: "",
      kind: "root",
      markers: [],
    });
  }

  subProjects.sort((a, b) => byOrdinal(a.root, b.root));
  await Promise.all(subProjects.map(async (p) => {
    const { names, local } = await declaredPackages(root, p);
    const [first, ...rest] = names;
    if (first) {
      p.packageName = first.name;
      p.packageEcosystem = first.ecosystem;
    }
    if (rest.length + local.length > 0) p.packages = [...rest, ...local];
    const implicit = await implicitImports(root, p);
    if (implicit.length > 0) p.implicitImports = implicit;
  }));
  return subProjects;
}

/**
 * What the build imports into every file of a sub-project (the registry's
 * `PackageManifestSpec.projectImports`), read from the manifests directly at
 * its root: core reads the files, the plugin reads the format.
 */
async function implicitImports(root: string, project: SubProject): Promise<string[]> {
  const out = new Set<string>();
  let entries: string[] | null = null;
  for (const manager of PACKAGE_MANAGERS) {
    for (const spec of manager.manifests) {
      if (!spec.projectImports) continue;
      entries ??= await readdir(join(root, project.root)).catch(() => []);
      const files = spec.glob
        ? entries.filter((e) => spec.files.some((f) => basenameGlob(f).test(e)))
        : spec.files.filter((f) => entries!.includes(f));
      for (const file of files) {
        const text = await readFile(join(root, project.root, file), "utf-8").catch(() => null);
        if (text === null) continue;
        for (const name of await spec.projectImports(text, selfNameContext(root, project.root, file))) out.add(name);
      }
    }
  }
  return [...out];
}

/**
 * The packages the manifests at a sub-project's root declare, asked of every
 * registered package-manager format that can say (the registry's
 * `PackageManifestSpec.selfName` / `localPackages`): core reads the file, the
 * plugin reads the format. The first format whose manifest names one gives
 * `packageName`; each other ecosystem's name follows, then the packages a
 * manifest maps to a directory of the repository (rooted inside it only).
 */
async function declaredPackages(
  root: string,
  project: SubProject,
): Promise<{ names: Array<{ name: string; ecosystem: PackageEcosystem }>; local: Array<{ name: string; ecosystem: PackageEcosystem; root: string }> }> {
  const out: Array<{ name: string; ecosystem: PackageEcosystem }> = [];
  const local: Array<{ name: string; ecosystem: PackageEcosystem; root: string }> = [];
  const dir = join(root, project.root);
  let entries: string[] | null = null;
  for (const manager of PACKAGE_MANAGERS) {
    let named = out.some((p) => p.ecosystem === manager.ecosystem);
    for (const spec of manager.manifests) {
      if (!spec.selfName && !spec.localPackages) continue;
      if (spec.glob) {
        // A format spread over many files names its package in the ONE file at the project's root that names one.
        if (!spec.selfName || named) continue;
        entries ??= await readdir(dir).catch(() => []);
        const names = new Set<string>();
        for (const file of entries.filter((e) => spec.files.some((f) => basenameGlob(f).test(e)))) {
          const text = await readFile(join(dir, file), "utf-8").catch(() => null);
          const name = text === null ? null : await spec.selfName(text, selfNameContext(root, project.root, file));
          if (name) names.add(name);
        }
        if (names.size === 1) {
          out.push({ name: [...names][0]!, ecosystem: manager.ecosystem });
          named = true;
        }
        continue;
      }
      for (const file of spec.files) {
        let text: string;
        try {
          text = await readFile(join(root, project.root, file), "utf-8");
        } catch {
          continue;
        }
        const name = named || !spec.selfName ? null : await spec.selfName(text, selfNameContext(root, project.root, file));
        if (name) {
          out.push({ name, ecosystem: manager.ecosystem });
          named = true;
        }
        for (const pkg of spec.localPackages?.(text) ?? []) {
          const dir = posix.normalize(posix.join(project.root.replace(/\\/g, "/"), posix.dirname(file), pkg.path)).replace(/\/+$/, "");
          if (dir === ".." || dir.startsWith("../") || posix.isAbsolute(dir)) continue;
          local.push({ name: pkg.name, ecosystem: manager.ecosystem, root: dir === "." ? "" : dir });
        }
      }
    }
  }
  return { names: out, local };
}

/** The file-name part of a `**\/*.csproj`-style pattern as a regex over a directory entry. */
function basenameGlob(pattern: string): RegExp {
  const base = pattern.slice(pattern.lastIndexOf("/") + 1);
  const body = base.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp("^" + body + "$", "i");
}

/** What a manifest's own-name reader may look at around it: its directory, and the directories above up to the analysis root. */
function selfNameContext(root: string, projectRoot: string, file: string): SelfNameContext {
  const dir = posix.dirname(posix.join(projectRoot.replace(/\\/g, "/"), file));
  const rel = dir === "." ? "" : dir;
  const read = (path: string) => readFile(join(root, path), "utf-8").catch(() => null);
  return {
    fileName: posix.basename(file),
    dirName: rel ? posix.basename(rel) : null,
    readSibling: (name) => read(posix.join(rel, name)),
    readAncestors: async (name) => {
      const out: string[] = [];
      for (let d = rel; d; ) {
        d = posix.dirname(d) === "." ? "" : posix.dirname(d);
        const text = await read(posix.join(d, name));
        if (text !== null) out.push(text);
      }
      return out;
    },
  };
}

/** True when this CMakeLists.txt declares a project (`project(...)` call). */
async function isCmakeProjectRoot(root: string, relPath: string): Promise<boolean> {
  try {
    const content = await readFile(join(root, relPath), "utf-8");
    return /^\s*project\s*\(/im.test(content);
  } catch {
    return false;
  }
}

/** The most specific kind among several markers in one directory, by `KIND_PRIORITY`. */
function pickPrimaryKind(kinds: Set<SubProjectKind>): SubProjectKind {
  for (const k of KIND_PRIORITY) if (kinds.has(k)) return k;
  return "root";
}

/**
 * A sub-project id from its relative path: separators and odd characters
 * become dashes; the empty path is `root`.
 */
function slugify(p: string): string {
  const slug = p
    .replace(/\\/g, "/")
    .replace(/[^A-Za-z0-9/_-]/g, "-")
    .replace(/\/+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "root";
}

/**
 * Return the id of the innermost sub-project whose root is an ancestor of
 * `filePath`. Falls back to "root" if no project encloses the file.
 */
export function assignProjectId(
  filePath: string,
  subProjects: SubProject[],
): string {
  const normalized = filePath.replace(/\\/g, "/");
  let best: SubProject | null = null;
  for (const sp of subProjects) {
    if (sp.root === "") continue;
    const prefix = sp.root.endsWith("/") ? sp.root : sp.root + "/";
    if (normalized === sp.root || normalized.startsWith(prefix)) {
      if (!best || sp.root.length > best.root.length) best = sp;
    }
  }
  return best ? best.id : "root";
}
