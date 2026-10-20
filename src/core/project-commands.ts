import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { PROJECT_COMMAND_READERS } from "../extractors/registry.js";
import type { ProjectAnalysis, SubProject } from "../types/analysis.js";
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
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const view: ProjectRootView = {
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
