import { posix } from "path";
import { manifestFor } from "../extractors/registry.js";
import { readAtRoots } from "./config-values.js";
import type { FileAnalysis, Language, SubProject } from "../types/analysis.js";

/**
 * Which file a bare import means when two files of a language answer to its
 * name (`uses Garage` beside `Win/Garage.pas` and `Posix/Garage.pas`), as the
 * project's build files state it (`LanguagePluginManifest.moduleSearchPaths`):
 *
 * 1. a file the project names as that module — a build file's own list, or an
 *    import naming the module and its file (`uses Garage in 'Win\Garage.pas'`)
 *    where the spec says such an import pins it;
 * 2. the one candidate in the project's own directory (where a build file or
 *    the sub-project root is), searched first;
 * 3. the first search directory holding one.
 *
 * The import's source is rewritten to that file's path from the importer, so
 * every pass after it (import index, graphs, linker) resolves it exactly.
 * Imports with a single candidate, or none the build files decide, are left
 * to the generic path rules. Project-level and in memory: the per-file JSON
 * keeps what the file says.
 */
export async function applyModuleSearchPaths(
  analyses: FileAnalysis[],
  projectRoot: string,
  subProjects: readonly SubProject[],
): Promise<number> {
  const languages = [...new Set(analyses.map((a) => a.language as Language))].filter((l) => manifestFor(l)?.moduleSearchPaths);
  let rewritten = 0;
  for (const language of languages) {
    const manifest = manifestFor(language)!;
    const spec = manifest.moduleSearchPaths!;
    const fold = manifest.caseInsensitiveNames ? (s: string) => s.toLowerCase() : (s: string) => s;
    const own = analyses.filter((a) => a.language === language);

    // Module name → the files of this language named so.
    const byStem = new Map<string, string[]>();
    const files = new Set<string>();
    for (const a of own) {
      files.add(a.filePath);
      const key = fold(stemOf(a.filePath));
      (byStem.get(key) ?? byStem.set(key, []).get(key)!).push(a.filePath);
    }
    if (![...byStem.values()].some((list) => list.length > 1)) continue;

    // What each sub-project's build files say, as paths from the analysis root.
    const roots = new Map(subProjects.map((p) => [p.id, p.root.replace(/\\/g, "/").replace(/\/+$/, "")]));
    const read = await readAtRoots(projectRoot, subProjects, [spec], (s, text, path, file) => {
      const { dirs, files: named, conditionalDirs } = s.parse(text, path);
      const base = dirOf(file);
      return [{ base, dirs: dirs.map((d) => join(base, d)), conditional: (conditionalDirs ?? []).map((d) => join(base, d)), files: named.map((f) => join(base, f)) }];
    });
    const plans = new Map<string, Plan>();
    const planOf = (project: string) => {
      let plan = plans.get(project);
      if (!plan) plans.set(project, (plan = { homes: new Set([fold(roots.get(project) ?? "")]), dirs: [], conditional: [], pins: new Map() }));
      return plan;
    };
    // A path the build files write in another case than the folder (Windows, `win\garage.pas`).
    const onDisk = new Map([...files].map((f) => [fold(f), f]));
    const pin = (project: string, written: string) => {
      const file = onDisk.get(fold(written));
      if (!file) return;
      const pins = planOf(project).pins;
      const key = fold(stemOf(file));
      // Two files named for one module decide nothing.
      pins.set(key, pins.has(key) && pins.get(key) !== file ? null : file);
    };
    for (const [project, list] of read) {
      const plan = planOf(project);
      for (const r of list) {
        plan.homes.add(fold(r.base));
        for (const d of r.dirs.map(fold)) if (!plan.dirs.includes(d)) plan.dirs.push(d);
        for (const d of r.conditional.map(fold)) if (!plan.conditional.includes(d)) plan.conditional.push(d);
        for (const f of r.files) pin(project, f);
      }
    }
    if (spec.pathImportsPin) {
      for (const a of own) {
        for (const imp of a.imports) {
          if (!imp.source.startsWith(".") || imp.specifiers.length !== 1) continue;
          const file = join(dirOf(a.filePath), imp.source);
          if (fold(stemOf(file)) === fold(imp.specifiers[0]!)) pin(a.projectId, file);
        }
      }
    }
    if (plans.size === 0) continue;

    for (const a of own) {
      const plan = plans.get(a.projectId);
      if (!plan) continue;
      for (const imp of a.imports) {
        if (!/^[A-Za-z_][\w.]*$/.test(imp.source)) continue;
        const candidates = byStem.get(fold(imp.source));
        if (!candidates || candidates.length < 2) continue;
        const chosen = choose(plan, candidates, fold(imp.source), fold);
        if (!chosen || chosen === a.filePath) continue;
        const written = imp.source;
        imp.source = relativeFrom(a.filePath, chosen);
        retarget(a, written, imp.source);
        rewritten++;
      }
    }
  }
  return rewritten;
}

/** What a sub-project's build files say; directories folded as the language compares names. */
interface Plan {
  homes: Set<string>;
  dirs: string[];
  /** Directories searched for some platform or configuration only. */
  conditional: string[];
  pins: Map<string, string | null>;
}

function choose(
  plan: Plan,
  candidates: readonly string[],
  key: string,
  fold: (s: string) => string,
): string | null {
  const pinned = plan.pins.get(key);
  if (pinned && candidates.includes(pinned)) return pinned;
  const home = candidates.filter((c) => plan.homes.has(fold(dirOf(c))));
  if (home.length === 1) return home[0]!;
  if (home.length > 1) return null;
  for (const dir of plan.dirs) {
    const inDir = candidates.filter((c) => fold(dirOf(c)) === dir);
    if (inDir.length === 1) return inDir[0]!;
    if (inDir.length > 1) return null;
  }
  // Directories a platform's group adds: which applies is the build's, so the one candidate they hold is the
  // answer, and two candidates (`Win/Garage.pas`, `Posix/Garage.pas`) are none — never the first listed.
  const conditioned = candidates.filter((c) => plan.conditional.includes(fold(dirOf(c))));
  return conditioned.length === 1 ? conditioned[0]! : null;
}

/** Calls classified into the module by its written name now name its file. */
function retarget(a: FileAnalysis, from: string, to: string): void {
  const fix = (calls: FileAnalysis["functions"][number]["calls"]) => {
    for (const c of calls) if (c.target === from) c.target = to;
  };
  for (const fn of a.functions) fix(fn.calls);
  for (const cls of a.classes) for (const m of cls.methods) fix(m.calls);
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** `base` + a relative path as written, normalized; "" for the root. */
function join(base: string, rel: string): string {
  const joined = posix.normalize(base ? `${base}/${rel.replace(/\\/g, "/")}` : rel.replace(/\\/g, "/")).replace(/^\.\/?/, "").replace(/\/+$/, "");
  return joined === "." ? "" : joined;
}

/** `./Win/Garage.pas` / `../Win/Garage.pas`: the file as the importer reaches it. */
function relativeFrom(importer: string, file: string): string {
  const rel = posix.relative(dirOf(importer) || ".", file);
  return rel.startsWith("../") ? rel : `./${rel}`;
}
