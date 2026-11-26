import { dirname } from "path";
import { readAtRoots, type ProjectConfigValue } from "./config-values.js";
import { CONFIG_SPECS } from "../extractors/registry.js";
import type { ConfigKeyUse, FileAnalysis, Language, SubProject } from "../types/analysis.js";
import type { ServiceConfigSpec } from "../types/language-plugin.js";

/**
 * Configuration keys joined to the code that reads them, so changing a key
 * shows its consumers. A config file declares a key (a plugin's
 * `serviceConfig.sources`); code states a read (`DataSourceInfo.configRead` on
 * an `env` row: a key or a prefix of keys; `FileAnalysis.configKeyReads`: a
 * variable block beside the file that sets it). Core joins them and names no language or format.
 *
 * The join is scoped, never by name alone: a read meets the keys of the
 * sub-project it sits in (a namesake key of another module is another
 * setting), a `variable` read the files in its own directory. A key only a test profile sets (`ConfigEntry.test`)
 * is read by test code only. Names and locations only — a value never reaches the summary.
 *
 * `serviceConfig.sources` states the keys config files set (`keysOnly: true`: no call origin may read it).
 * Relaxed binding (`match-day` = `matchDay` = `match_day`, a plugin's `serviceConfig.normalizeKey`) and
 * `envNamesFor` match a key. Rows exist only for read keys and cap at 50 consumers; a key whose `envNamesFor`
 * names a deployed service sets joins that variable's reads (`env-vars.ts`).
 */
export interface ConfigSet {
  languages: ReadonlySet<Language>;
  spec: ServiceConfigSpec;
  /** Entries per sub-project id. */
  byProject: Map<string, ProjectConfigValue[]>;
}

/** Every key the plugins' config files state, per spec and sub-project. */
export async function readConfigKeys(
  projectRoot: string,
  subProjects: readonly SubProject[],
  specs = CONFIG_SPECS,
): Promise<ConfigSet[]> {
  const out: ConfigSet[] = [];
  for (const { languages, spec } of specs) {
    const byProject = await readAtRoots(projectRoot, subProjects, spec.sources ?? [], (src, text, path, file) =>
      src.parse(text, path).filter((e) => !e.env && !e.listen).map((e) => ({ ...e, file })),
    );
    if (byProject.size > 0) out.push({ languages, spec, byProject });
  }
  return out;
}


const MAX_CONSUMERS = 50;

export function joinConfigKeys(
  analyses: readonly FileAnalysis[],
  sets: readonly ConfigSet[],
  isAuthored: (file: string) => boolean,
  isTest: (file: string, language: Language) => boolean,
): ConfigKeyUse[] {
  if (sets.length === 0) return [];
  const rows = new Map<string, ConfigKeyUse>();
  const allEntries = new Map<ConfigSet, Array<{ e: ProjectConfigValue; project: string }>>();
  for (const a of analyses) {
    if (!isAuthored(a.filePath)) continue;
    const reads: Array<{ kind: "key" | "prefix" | "variable"; target: string; line: number }> = [
      ...a.dataSources.flatMap((d) => (d.kind === "env" && d.configRead && d.target ? [{ kind: d.configRead.kind, target: d.target, line: d.line }] : [])),
      ...(a.configKeyReads ?? []).map((r) => ({ kind: r.kind, target: r.key, line: r.line })),
    ];
    if (reads.length === 0) continue;
    const test = isTest(a.filePath, a.language);
    for (const set of sets) {
      let all = allEntries.get(set);
      if (!all) {
        // A file of nested sub-projects is read once per enclosing project: keep the first.
        const seen = new Set<string>();
        all = [...set.byProject].flatMap(([project, list]) => list.map((e) => ({ e, project }))).filter(({ e }) => !seen.has(e.file + "\0" + e.key) && !!seen.add(e.file + "\0" + e.key));
        allEntries.set(set, all);
      }
      if (!set.languages.has(a.language)) continue;
      for (const read of reads) {
        const kind = read.kind;
        const target = read.target;
        // A `variable` read meets the files beside it; the others the keys of the project.
        const entries = kind === "variable"
          ? all.filter(({ e }) => dirname(e.file) === dirname(a.filePath))
          : (set.byProject.get(a.projectId ?? "root") ?? []).map((e) => ({ e, project: a.projectId ?? "root" }));
        const dir = dirname(a.filePath);
        // The plugin says which spellings are one key; without a rule a key is compared as written.
        const norm = set.spec.normalizeKey ?? ((k: string) => k);
        const want = norm(target);
        for (const { e, project } of entries) {
          if (e.test && !test) continue;
          let hit: boolean;
          if (kind === "variable") hit = dirname(e.file) === dir && e.key === target;
          else if (kind === "prefix") hit = /^[.[]/.test(norm(e.key).slice(want.length)) && norm(e.key).startsWith(want);
          else hit = norm(e.key) === want || norm(e.key).startsWith(want + "[") || (set.spec.envNamesFor?.(e.key) ?? []).some((n) => n.toLowerCase() === target.toLowerCase());
          if (!hit) continue;
          const id = `${e.file}\0${e.line ?? 0}\0${e.key}`;
          const row = rows.get(id) ?? rows.set(id, {
            key: e.key,
            file: e.file,
            ...(e.line ? { line: e.line } : {}),
            project,
            ...(e.profile ? { profile: e.profile } : {}),
            ...(e.test ? { test: true } : {}),
            consumers: [],
          }).get(id)!;
          const via = kind === "variable" ? "variable" : kind === "prefix" ? "prefix" : "value";
          if (row.consumers.length < MAX_CONSUMERS && !row.consumers.some((c) => c.file === a.filePath && c.line === read.line && c.via === via)) {
            row.consumers.push({ file: a.filePath, line: read.line, ...(a.projectId ? { project: a.projectId } : {}), via });
          }
        }
      }
    }
  }
  return [...rows.values()].sort((x, y) => (x.file + x.key < y.file + y.key ? -1 : x.file + x.key > y.file + y.key ? 1 : 0));
}
