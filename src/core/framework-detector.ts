import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";
import fg from "fast-glob";
import type { FrameworkDetection } from "../types/analysis.js";
import type { ProjectInfo } from "../types/plugin.js";
import { FRAMEWORK_RULES, FRAMEWORK_MARKER_CANDIDATES } from "../extractors/registry.js";

/**
 * Framework detection over project/sub-project manifests. The rules themselves
 * live with the language plugins (`plugins/<lang>/frameworks.ts`, aggregated by
 * the registry into `FRAMEWORK_RULES`) — this module only gathers the
 * `ProjectInfo` evidence and runs the rules, so core knows no framework names.
 */

/** Gather project info from manifest files */
export async function gatherProjectInfo(
  projectRoot: string,
): Promise<ProjectInfo> {
  const root = resolve(projectRoot);

  // Read package.json
  let packageJson: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(join(root, "package.json"), "utf-8");
    packageJson = JSON.parse(raw);
  } catch {
    // No package.json
  }

  // Find .csproj files
  const csprojFiles = await fg("**/*.csproj", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/bin/**", "**/obj/**"],
    absolute: false,
    deep: 3,
  });

  // Concatenate .csproj contents for PackageReference scanning.
  let csprojText = "";
  for (const f of csprojFiles.slice(0, 20)) {
    try {
      csprojText += "\n" + (await readFile(join(root, f), "utf-8"));
    } catch {
      // Skip unreadable file
    }
  }

  // Read Python manifest (pyproject.toml as JSON-compatible or requirements.txt)
  let pythonManifest: Record<string, unknown> | null = null;
  try {
    const reqRaw = await readFile(join(root, "requirements.txt"), "utf-8");
    pythonManifest = {
      dependencies: reqRaw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    };
  } catch {
    // Try pyproject.toml (basic parse)
    try {
      const raw = await readFile(join(root, "pyproject.toml"), "utf-8");
      // Extract dependencies line by line (simple parse, not full TOML)
      const deps: string[] = [];
      let inDeps = false;
      for (const line of raw.split("\n")) {
        if (line.match(/^\[.*dependencies.*\]/i)) {
          inDeps = true;
          continue;
        }
        if (line.startsWith("[") && inDeps) break;
        if (inDeps) {
          const match = line.match(/["']([^"']+)["']/);
          if (match) deps.push(match[1]);
        }
      }
      if (deps.length > 0) {
        pythonManifest = { dependencies: deps };
      }
    } catch {
      // No Python manifest
    }
  }

  // Read Gradle build file
  let gradleFile: string | null = null;
  for (const name of ["build.gradle.kts", "build.gradle"]) {
    try {
      gradleFile = await readFile(join(root, name), "utf-8");
      break;
    } catch {
      // Try next
    }
  }

  // Read Maven pom.xml
  let pomXml: string | null = null;
  try {
    pomXml = await readFile(join(root, "pom.xml"), "utf-8");
  } catch {
    // No pom.xml
  }

  // Get file extensions
  const fileExtensions = new Set<string>();
  const sampleFiles = await fg("**/*.*", {
    cwd: root,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/bin/**",
      "**/obj/**",
    ],
    absolute: false,
    deep: 3,
  });
  for (const f of sampleFiles) {
    const dot = f.lastIndexOf(".");
    if (dot >= 0) fileExtensions.add(f.slice(dot));
  }

  // Find .dproj files (Delphi)
  const dprojFiles = await fg("**/*.dproj", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/bin/**", "**/obj/**"],
    absolute: false,
    deep: 3,
  });

  // Find .lpi files (Lazarus)
  const lpiFiles = await fg("**/*.lpi", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/bin/**", "**/obj/**"],
    absolute: false,
    deep: 3,
  });

  // Scan a few Pascal source files for uses clauses (for framework detection)
  const delphiUses: string[] = [];
  const pasFiles = await fg("**/*.{pas,dpr,lpr}", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/bin/**", "**/obj/**", "**/__history/**"],
    absolute: false,
    deep: 3,
  });
  for (const pf of pasFiles.slice(0, 10)) {
    try {
      const content = await readFile(join(root, pf), "utf-8");
      // Simple regex to extract unit names from uses clauses
      const usesMatches = content.matchAll(/\buses\b\s+([\s\S]*?);/gi);
      for (const m of usesMatches) {
        const units = m[1].split(",").map((u) => u.trim().replace(/\s+/g, ""));
        delphiUses.push(...units.filter((u) => u.length > 0));
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Read go.mod, Cargo.toml, composer.json, Gemfile — for cross-language ORM detection.
  let goMod: string | null = null;
  try { goMod = await readFile(join(root, "go.mod"), "utf-8"); } catch { /* no go.mod */ }

  let cargoToml: string | null = null;
  try { cargoToml = await readFile(join(root, "Cargo.toml"), "utf-8"); } catch { /* no Cargo.toml */ }

  let composerJson: string | null = null;
  try { composerJson = await readFile(join(root, "composer.json"), "utf-8"); } catch { /* no composer.json */ }

  let gemfile: string | null = null;
  try { gemfile = await readFile(join(root, "Gemfile"), "utf-8"); } catch { /* no Gemfile */ }

  let pubspecYaml: string | null = null;
  try { pubspecYaml = await readFile(join(root, "pubspec.yaml"), "utf-8"); } catch { /* no pubspec.yaml */ }

  let packageSwift: string | null = null;
  try { packageSwift = await readFile(join(root, "Package.swift"), "utf-8"); } catch { /* no Package.swift */ }

  let cljProject: string | null = null;
  for (const name of ["project.clj", "deps.edn"]) {
    try { cljProject = await readFile(join(root, name), "utf-8"); break; } catch { /* try next */ }
  }

  let cmakeLists: string | null = null;
  try { cmakeLists = await readFile(join(root, "CMakeLists.txt"), "utf-8"); } catch { /* no CMakeLists.txt */ }

  // Find .sql / .ddl files for raw-SQL framework detection
  const sqlFiles = await fg("**/*.{sql,ddl,dml,psql,tsql,plsql,mysql}", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/bin/**", "**/obj/**"],
    absolute: false,
    deep: 5,
  });

  // JSP views + Spring Web Flow definitions (Java web monoliths nest these
  // deep under src/main/webapp/, hence the higher depth).
  const jspFiles = await fg("**/*.jsp", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/target/**", "**/.git/**"],
    absolute: false,
    deep: 8,
  });
  const webflowFiles = await fg(["**/*webflow*.xml", "**/WEB-INF/flows/**/*.xml"], {
    cwd: root,
    ignore: ["**/node_modules/**", "**/target/**", "**/.git/**"],
    absolute: false,
    deep: 9,
  });

  // Framework marker files no manifest records (vendored frameworks) —
  // candidate paths are plugin-contributed via `meta.markerCandidates`.
  const markerFiles = FRAMEWORK_MARKER_CANDIDATES.filter((rel) =>
    existsSync(join(root, ...rel.split("/"))),
  );

  return {
    root,
    packageJson,
    csprojFiles,
    csprojText,
    pythonManifest,
    gradleFile,
    pomXml,
    fileExtensions,
    dprojFiles,
    lpiFiles,
    delphiUses,
    goMod,
    cargoToml,
    composerJson,
    gemfile,
    pubspecYaml,
    packageSwift,
    cljProject,
    sqlFiles,
    jspFiles,
    webflowFiles,
    cmakeLists,
    markerFiles,
  };
}

/**
 * Detect frameworks used in the project. Runs every plugin-contributed rule
 * against the gathered info; results are sorted by id so the output is
 * independent of plugin registration order.
 */
export function detectFrameworks(
  projectInfo: ProjectInfo,
): FrameworkDetection[] {
  const results: FrameworkDetection[] = [];

  for (const rule of FRAMEWORK_RULES) {
    if (rule.check(projectInfo)) {
      results.push({
        id: rule.id,
        name: rule.name,
        confidence: "high",
        detectedVia: rule.detectedVia,
      });
    }
  }

  return results.sort((a, b) => a.id.localeCompare(b.id));
}

export interface MultiRootFrameworks {
  /** De-duped union across the analyzed root and every sub-project root. */
  merged: FrameworkDetection[];
  /** Per-root detections, keyed by the (relative) root string passed in (`""` = analyzed root). */
  byRoot: Map<string, FrameworkDetection[]>;
}

/**
 * Detect frameworks at the analyzed root AND at each sub-project root, merging
 * the results. Build manifests (`package.json`, `Gemfile`, `*.csproj`, …) are
 * frequently nested — a `/spa` Vue app beside a `/server` Rails app under one
 * repo, or a wrapper dir whose real app lives a level down — so a root-only scan
 * (which reads `package.json`/`Gemfile`/`go.mod`/… at exactly the root) sees
 * none of them and the project looks frameworkless. Gathering per sub-project
 * root closes that gap. Detections are de-duped by framework id, first root wins
 * (for the detectedVia evidence); the merged list is sorted by id.
 *
 * `subRoots` are relative to `projectRoot` (the same strings carried on
 * `SubProject.root`); `""` denotes the analyzed root and is always included.
 */
export async function detectFrameworksAcrossRoots(
  projectRoot: string,
  subRoots: readonly string[],
): Promise<MultiRootFrameworks> {
  const roots = ["", ...subRoots].filter((r, i, a) => a.indexOf(r) === i);
  const byRoot = new Map<string, FrameworkDetection[]>();
  const merged = new Map<string, FrameworkDetection>();
  for (const rel of roots) {
    const info = await gatherProjectInfo(rel ? resolve(projectRoot, rel) : projectRoot);
    const fws = detectFrameworks(info);
    byRoot.set(rel, fws);
    for (const f of fws) if (!merged.has(f.id)) merged.set(f.id, f);
  }
  return {
    merged: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)),
    byRoot,
  };
}
