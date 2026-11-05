import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { PROJECT_COMMAND_READERS, TEST_SETUP_READERS } from "../extractors/registry.js";
import type { FileAnalysis, ProjectAnalysis, SubProject } from "../types/analysis.js";
import type { ProjectRootView } from "../types/language-plugin.js";

/** Characters of a root file a reader may see (a manifest, not a lockfile). */
const READ_LIMIT = 256 * 1024;

/**
 * How each sub-project is built, tested and started, as its own root files
 * say. The language plugins read them (`LanguagePluginManifest.projectCommands`);
 * this only walks the roots and keeps, per root and kind, the first command a
 * plugin names. Nothing is run.
 */
export function collectProjectCommands(projectRoot: string, subProjects: readonly Pick<SubProject, "id" | "root">[]): NonNullable<ProjectAnalysis["projectCommands"]> {
  const out: NonNullable<ProjectAnalysis["projectCommands"]> = [];
  for (const sp of subProjects) {
    const dir = join(projectRoot, sp.root);
    const view = projectRootView(dir);
    if (!view) continue;
    const kinds = new Set<string>();
    for (const read of PROJECT_COMMAND_READERS) {
      let found;
      try {
        found = read(view);
      } catch {
        continue; // a malformed manifest says nothing
      }
      for (const c of found) {
        if (kinds.has(c.kind)) continue;
        kinds.add(c.kind);
        out.push({ projectId: sp.id, root: sp.root, ...c });
      }
    }
  }
  return out;
}

/** What a plugin reader sees of the directory `dir`; null when it cannot be listed. */
function projectRootView(dir: string): ProjectRootView | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  return {
    entries,
    read: (rel) => {
      try {
        const text = readFileSync(join(dir, rel), "utf8");
        return text.length > READ_LIMIT ? text.slice(0, READ_LIMIT) : text;
      } catch {
        return undefined;
      }
    },
    exists: (rel) => existsSync(join(dir, rel)),
  };
}

/**
 * The files each sub-project's test framework runs while setting a test run up, as the
 * language plugins read its root's test configuration (`LanguagePluginManifest.testSetupRuns`)
 * — handed the sub-project's own analyses. Nothing is run.
 */
export function collectTestSetupRuns(
  projectRoot: string,
  subProjects: readonly Pick<SubProject, "id" | "root">[],
  analyses: readonly FileAnalysis[],
): NonNullable<ProjectAnalysis["testSetupRuns"]> {
  if (TEST_SETUP_READERS.length === 0) return [];
  const byProject = new Map<string, FileAnalysis[]>();
  for (const a of analyses) (byProject.get(a.projectId) ?? byProject.set(a.projectId, []).get(a.projectId)!).push(a);
  const out = new Map<string, string>();
  for (const sp of subProjects) {
    const files = byProject.get(sp.id);
    if (!files) continue;
    const view = projectRootView(join(projectRoot, sp.root));
    if (!view) continue;
    for (const read of TEST_SETUP_READERS) {
      let found;
      try {
        found = read(view, files);
      } catch {
        continue; // a malformed configuration says nothing
      }
      for (const f of found) if (!out.has(f.file)) out.set(f.file, f.reason);
    }
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, reason]) => ({ file, reason }));
}
