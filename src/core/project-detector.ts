import fg from "fast-glob";
import { NO_SYMLINKS } from "./glob-safety.js";
import { byOrdinal } from "./ordinal.js";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import type { PackageEcosystem, SubProject, SubProjectKind } from "../types/analysis.js";
import { loadIgnorePatterns, isIgnored } from "./clarifydoc-ignore.js";
import { PACKAGE_MANAGERS } from "../extractors/registry.js";

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
  // Only a CMakeLists.txt containing a project() call marks a project root —
  // most CMakeLists are per-directory source lists (add_subdirectory targets)
  // and treating them as markers would fragment the repo under innermost-wins.
  { pattern: "**/CMakeLists.txt", kind: "cmake" },
];

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

  const byDir = new Map<
    string,
    { kinds: Set<SubProjectKind>; markers: Set<string> }
  >();

  for (const { pattern, kind } of MARKER_GLOBS) {
    const found = await fg(pattern, {
      ...NO_SYMLINKS,
      cwd: root,
      ignore: MARKER_IGNORE,
      absolute: false,
      dot: false,
      // Legacy Windows repos ship PROJECT.DPR / MAKEFILE-cased markers.
      caseSensitiveMatch: false,
    });
    const matches = ignorePatterns.length === 0
      ? found
      : found.filter((rel) => !isIgnored(join(root, rel), root, ignorePatterns));
    for (const match of matches) {
      if (kind === "cmake" && !(await isCmakeProjectRoot(root, match))) continue;
      const norm = match.replace(/\\/g, "/");
      const lastSlash = norm.lastIndexOf("/");
      const dir = lastSlash >= 0 ? norm.slice(0, lastSlash) : "";
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
    const declared = await declaredPackageName(root, p);
    if (declared) {
      p.packageName = declared.name;
      p.packageEcosystem = declared.ecosystem;
    }
  }));
  return subProjects;
}

/**
 * The name the manifest at `dir` declares for its own package, asked of every
 * registered package-manager format that can say (the registry's
 * `PackageManifestSpec.selfName`): core reads the file, the plugin reads the
 * format. The first format whose manifest is present and names one wins.
 */
async function declaredPackageName(
  root: string,
  project: SubProject,
): Promise<{ name: string; ecosystem: PackageEcosystem } | null> {
  for (const manager of PACKAGE_MANAGERS) {
    for (const spec of manager.manifests) {
      if (!spec.selfName || spec.glob) continue;
      for (const file of spec.files) {
        let text: string;
        try {
          text = await readFile(join(root, project.root, file), "utf-8");
        } catch {
          continue;
        }
        const name = spec.selfName(text);
        if (name) return { name, ecosystem: manager.ecosystem };
      }
    }
  }
  return null;
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

function pickPrimaryKind(kinds: Set<SubProjectKind>): SubProjectKind {
  for (const k of KIND_PRIORITY) if (kinds.has(k)) return k;
  return "root";
}

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
