import { posix } from "path";
import { COMPILATION_DATABASES } from "../extractors/registry.js";
import { readAtRoots } from "./config-values.js";
import type { BuildMacros } from "../types/language-plugin.js";
import type { FileAnalysis, SubProject } from "../types/analysis.js";

/**
 * What a project's compilation database (`compile_commands.json`, `LanguagePluginManifest.compilationDatabase`)
 * says of one translation unit, paths as the project names them: the directories its compiler searches for an
 * `#include`, in order, and the macros its command line sets. A file the database lists twice has two.
 */
export interface BuildUnit {
  /** `-iquote` directories, searched after the includer's own directory. */
  quote: string[];
  /** `-I` directories, then `-isystem`. */
  angle: string[];
  macros: BuildMacros;
}

/** Project-relative file → its translation units. Headers are never entries. */
export type CompilationDatabase = ReadonlyMap<string, readonly BuildUnit[]>;

/**
 * The compilation databases at each sub-project root, mapped onto the files discovered. A path the build wrote on
 * another machine (`/home/ci/league/src/main.c`) is matched to the project by its longest tail that names a
 * discovered file or directory; one that matches nothing is dropped.
 */
export async function loadCompilationDatabase(
  projectRoot: string,
  subProjects: readonly SubProject[],
  files: readonly string[],
): Promise<CompilationDatabase> {
  const out = new Map<string, BuildUnit[]>();
  if (COMPILATION_DATABASES.length === 0 || files.length === 0) return out;
  const known = new Set(files);
  const dirs = new Set<string>([""]);
  for (const f of files) for (let d = posix.dirname(f); d !== "." && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");

  /** A path of the database as a project-relative one, or null when it is outside the project. */
  const inProject = (abs: string, isFile: boolean): string | null => {
    const p = posix.normalize(abs.replace(/\\/g, "/"));
    if (p === root) return "";
    if (p.startsWith(`${root}/`)) return p.slice(root.length + 1);
    const parts = p.replace(/^[A-Za-z]:/, "").split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const tail = parts.slice(i).join("/");
      if (isFile ? known.has(tail) : dirs.has(tail)) return tail;
    }
    return null;
  };

  const read = await readAtRoots(projectRoot, subProjects, COMPILATION_DATABASES, (spec, text, _path, file) => {
    const base = posix.dirname(file) === "." ? "" : posix.dirname(file);
    return spec.parse(text).map((unit) => ({ unit, base }));
  });
  for (const rows of read.values()) {
    for (const { unit, base } of rows) {
      const directory = unit.directory ? (posix.isAbsolute(unit.directory) || /^[A-Za-z]:/.test(unit.directory) ? unit.directory : posix.join(root, base, unit.directory)) : posix.join(root, base);
      const absolute = (p: string): string => (posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : posix.join(directory, p));
      const file = inProject(absolute(unit.file), true);
      if (!file || !known.has(file)) continue;
      const mapDirs = (list: readonly string[]) => list.flatMap((d) => {
        const mapped = inProject(absolute(d), false);
        return mapped === null ? [] : [mapped];
      });
      const build: BuildUnit = {
        quote: mapDirs(unit.quoteDirs),
        angle: mapDirs([...unit.includeDirs, ...unit.systemDirs]),
        macros: unit.macros,
      };
      (out.get(file) ?? out.set(file, []).get(file)!).push(build);
    }
  }
  return out;
}

/**
 * The macros every translation unit of a file agrees on, in command-line order within the first; a macro the units
 * set differently is not known. Undefined when the file has no unit.
 */
export function macrosOf(units: readonly BuildUnit[] | undefined): BuildMacros | undefined {
  if (!units || units.length === 0) return undefined;
  const state = (u: BuildUnit) => {
    const m = new Map<string, string | null>();
    for (const x of u.macros) m.set(x.name, x.undefined ? null : (x.value ?? "1"));
    return m;
  };
  const states = units.map(state);
  const out: Array<{ name: string; value?: string; undefined?: boolean }> = [];
  for (const [name, value] of states[0]!) {
    if (states.every((s) => s.has(name) && s.get(name) === value)) out.push(value === null ? { name, undefined: true } : { name, value });
  }
  return out;
}

/** A stable text of a file's macros, for the incremental cache's stamp. */
export function macrosStamp(units: readonly BuildUnit[] | undefined): string | undefined {
  const macros = macrosOf(units);
  return macros === undefined ? undefined : JSON.stringify(macros);
}

/**
 * Each include a unit's compiler resolves is rewritten to the file's path from its includer, ahead of the suffix
 * fallback that cannot tell two `config.h` apart: the includer's directory, the `-iquote` directories, then `-I`
 * and `-isystem` as ordered (an import does not say whether it was written `"x"` or `<x>`, so both search all). An include the translation units
 * resolve to different files (a file compiled twice with other flags), or none of them finds, keeps its source.
 * A header has no unit of its own and keeps the generic rules.
 */
export function placeIncludes(analyses: readonly FileAnalysis[], db: CompilationDatabase, files: ReadonlySet<string>): number {
  let placed = 0;
  for (const a of analyses) {
    const units = db.get(a.filePath);
    if (!units) continue;
    const own = posix.dirname(a.filePath) === "." ? "" : posix.dirname(a.filePath);
    for (const imp of a.imports) {
      // An include names a file with its extension; `using namespace foo;` and the like name none.
      const name = imp.source.replace(/^\.\//, "");
      if (imp.executes || imp.isType || imp.source.startsWith("..") || !/\.\w+$/.test(name) || /^[A-Za-z]+:/.test(name)) continue;
      const found = new Set<string | null>();
      for (const unit of units) {
        const search = [own, ...unit.quote, ...unit.angle];
        found.add(search.map((d) => posix.join(d, name)).find((f) => files.has(f)) ?? null);
      }
      const [file] = found;
      if (found.size !== 1 || !file || file === a.filePath) continue;
      const rel = posix.relative(own || ".", file);
      const source = rel.startsWith("../") ? rel : `./${rel}`;
      if (source === imp.source) continue;
      imp.source = source;
      placed++;
    }
  }
  return placed;
}
