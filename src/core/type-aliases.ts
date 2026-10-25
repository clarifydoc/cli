import type { FileAnalysis, Language } from "../types/analysis.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { resolveTarget } from "../extractors/shared/link-scoring.js";
import { sameTypeSpace } from "./typed-receivers.js";

/**
 * Type aliases followed for receivers: a field, parameter or local declared
 * with an alias (`type Repo = ClubRepository`, `using Repo = League.ClubRepository;`)
 * is typed by what the alias stands for, so `repo.save()` reaches
 * `ClubRepository.save` as it does when the class is named.
 */

interface AliasDef {
  file: string;
  /** Names the type only inside `file`. */
  fileScoped?: boolean;
  /** The aliased type, normalized the way a declared type is (`receiverTypeName`). */
  target: string;
}

export interface TypeAliasIndex {
  byName: Map<string, AliasDef[]>;
  languageOf: (file: string) => string;
  projectOf: (file: string) => string | undefined;
  analysisOf: (file: string) => FileAnalysis | undefined;
  filePathMap: Map<string, string>;
}

/** Every alias the analyses declare, by name; null when none does. */
export function buildTypeAliasIndex(analyses: readonly FileAnalysis[], filePathMap: Map<string, string>): TypeAliasIndex | null {
  const byName = new Map<string, AliasDef[]>();
  for (const a of analyses) {
    for (const alias of a.typeAliases ?? []) {
      const target = receiverTypeName(alias.type, a.language as Language);
      if (!target || target === alias.name) continue;
      (byName.get(alias.name) ?? byName.set(alias.name, []).get(alias.name)!).push({ file: a.filePath, target, ...(alias.fileScoped ? { fileScoped: true } : {}) });
    }
  }
  if (byName.size === 0) return null;
  const files = new Map(analyses.map((a) => [a.filePath, a]));
  return {
    byName,
    languageOf: (f) => files.get(f)?.language ?? "",
    projectOf: (f) => files.get(f)?.projectId,
    analysisOf: (f) => files.get(f),
    filePathMap,
  };
}

/** Longest alias chain followed (`type A = B; type B = Club`). */
const MAX_ALIAS_HOPS = 4;

/**
 * The type `typeName` stands for as seen from `sourceFile`: the alias the file
 * declares itself, else the one an import of that name leads to, else — when
 * no class of the name is in the file's type space (`isClass`) — the one alias
 * of the name in the caller's sub-project, or in its type space. Followed
 * through further aliases; the name itself when it is no alias.
 */
export function followTypeAlias(
  index: TypeAliasIndex | null,
  typeName: string,
  sourceFile: string,
  isClass: (name: string, nearFile: string) => boolean,
): string {
  if (!index) return typeName;
  let name = typeName;
  let near = sourceFile;
  const seen = new Set<string>();
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const defs = index.byName.get(name);
    if (!defs || seen.has(name)) return name;
    seen.add(name);
    const lang = index.languageOf(near);
    const inSpace = defs.filter((d) => (!d.fileScoped || d.file === near) && sameTypeSpace(near, lang, d.file, index.languageOf(d.file)));
    const def = pickAlias(index, inSpace, name, near, isClass);
    if (!def) return name;
    name = def.target;
    near = def.file;
  }
  return name;
}

function pickAlias(
  index: TypeAliasIndex,
  defs: AliasDef[],
  name: string,
  near: string,
  isClass: (name: string, nearFile: string) => boolean,
): AliasDef | null {
  if (defs.length === 0) return null;
  const own = defs.find((d) => d.file === near);
  if (own) return own;
  const source = index.analysisOf(near);
  for (const imp of source?.imports ?? []) {
    if (!imp.specifiers.includes(name)) continue;
    const f = resolveTarget(imp.source, near, index.filePathMap);
    const hit = f ? defs.find((d) => d.file === f) : undefined;
    if (hit) return hit;
  }
  // A class of that name is what the name means wherever no alias is stated nearer.
  if (isClass(name, near)) return null;
  const project = index.projectOf(near);
  const sameProject = defs.filter((d) => index.projectOf(d.file) === project);
  const pool = sameProject.length > 0 ? sameProject : defs;
  // Several declarations agreeing on the type are one answer.
  return new Set(pool.map((d) => d.target)).size === 1 ? pool[0]! : null;
}
