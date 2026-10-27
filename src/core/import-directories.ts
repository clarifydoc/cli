import type { Language, SubProject } from "../types/analysis.js";
import type { PackageRoot } from "../types/language-plugin.js";
import { manifestFor, packageEcosystemsFor } from "../extractors/registry.js";

/** Resolves a package import to a directory; `exact` says whether the language's own package rule decided it. */
export interface ImportDirectoryResolver {
  (source: string, fromFile: string): string | null;
  /** The plugin's answer (`packageDirectory`): a directory holding analyzed files, null for no package of the repository, else undefined. */
  exact(source: string, fromFile: string): string | null | undefined;
}

/**
 * The packages of this repository by the name an importer writes, per
 * ecosystem: each sub-project's declared names (`packageName`, `packages`).
 */
export function packageRootsOf(subProjects: readonly SubProject[]): Map<string, PackageRoot[]> {
  const out = new Map<string, PackageRoot[]>();
  const add = (ecosystem: string, name: string, root: string) => {
    const list = out.get(ecosystem) ?? out.set(ecosystem, []).get(ecosystem)!;
    if (!list.some((p) => p.name === name && p.root === root)) list.push({ name, root });
  };
  for (const p of subProjects) {
    const root = p.root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p.packageName && p.packageEcosystem) add(p.packageEcosystem, p.packageName, root);
    for (const pkg of p.packages ?? []) add(pkg.ecosystem, pkg.name, pkg.root ?? root);
  }
  return out;
}

/**
 * The ONE project directory a package import names (Go, Rust, Ruby —
 * `importsNameDirectories`). A language that knows how its import paths map
 * to directories (`packageDirectory`: a Go import is the go.mod module path,
 * then the directory) decides it from the repository's packages, exactly —
 * the standard library and downloads are no directory. Otherwise, or when no
 * manifest names a package, the directory whose path ends with the longest
 * run of the import's trailing segments (`code.example.com/league/modules/setting`
 * → `modules/setting`, never `routers/web/repo/setting`). Anchored when two or
 * more segments agree, or the whole directory path does (a root-level
 * `handler/` under a module path); otherwise only a directory unique by name
 * in the importer's sub-project. A tie is no directory — fanning one import
 * out across same-named packages made a large Go graph ~4× its real size.
 */
export function buildImportDirectoryResolver(
  analyses: ReadonlyArray<{ filePath: string; projectId?: string; language?: Language }>,
  subProjects: readonly SubProject[] = [],
): ImportDirectoryResolver {
  const languageOf = new Map<string, Language>();
  const roots = packageRootsOf(subProjects);
  const projectOf = new Map<string, string>();
  const firstFileOf = new Map<string, string>();
  const dirsByName = new Map<string, string[]>();
  for (const a of analyses) {
    if (a.projectId) projectOf.set(a.filePath, a.projectId);
    if (a.language) languageOf.set(a.filePath, a.language);
    const slash = a.filePath.lastIndexOf("/");
    const dir = slash >= 0 ? a.filePath.slice(0, slash) : "";
    if (firstFileOf.has(dir)) continue;
    firstFileOf.set(dir, a.filePath);
    if (!dir) continue;
    const name = dir.slice(dir.lastIndexOf("/") + 1);
    (dirsByName.get(name) ?? dirsByName.set(name, []).get(name)!).push(dir);
  }
  const cache = new Map<string, string | null>();
  const exactCache = new Map<string, string | null | undefined>();
  const packagesFor = new Map<Language, PackageRoot[]>();
  const exact = (source: string, fromFile: string): string | null | undefined => {
    const language = languageOf.get(fromFile);
    const rule = language ? manifestFor(language)?.packageDirectory : undefined;
    if (!language || !rule) return undefined;
    const key = `${fromFile}\0${source}`;
    if (exactCache.has(key)) return exactCache.get(key);
    let packages = packagesFor.get(language);
    if (!packages) packagesFor.set(language, (packages = packageEcosystemsFor(language).flatMap((e) => roots.get(e) ?? [])));
    const dir = rule(fromFile, source, packages, (d) => firstFileOf.has(d));
    // A package of the repository whose directory holds no analyzed file (generated code, gitignored)
    // is not foreign: the trailing-segment match may still find its source (the `.proto` it is built from).
    const result = dir === null || dir === undefined ? dir : firstFileOf.has(dir) ? dir : undefined;
    exactCache.set(key, result);
    return result;
  };
  const resolver = ((source: string, fromFile: string): string | null => {
    const decided = exact(source, fromFile);
    if (decided !== undefined) return decided;
    const project = projectOf.get(fromFile) ?? "";
    const key = `${project}\0${source}`;
    if (cache.has(key)) return cache.get(key)!;
    const segs = source.split(/[/\\.:]+/).filter(Boolean);
    const dirs = dirsByName.get(segs[segs.length - 1] ?? "") ?? [];
    const scored = dirs.map((d) => {
      const dsegs = d.split("/");
      let k = 0;
      while (k < dsegs.length && k < segs.length && dsegs[dsegs.length - 1 - k] === segs[segs.length - 1 - k]) k++;
      return { d, k, anchored: k >= 2 || k === dsegs.length };
    });
    const projectOfDir = (d: string) => projectOf.get(firstFileOf.get(d)!) ?? "";
    const unique = (list: typeof scored): string | null => {
      if (list.length === 1) return list[0]!.d;
      const own = list.filter((c) => projectOfDir(c.d) === project);
      return own.length === 1 ? own[0]!.d : null;
    };
    const anchored = scored.filter((c) => c.anchored);
    let result: string | null;
    if (anchored.length > 0) {
      const best = Math.max(...anchored.map((c) => c.k));
      result = unique(anchored.filter((c) => c.k === best));
    } else {
      const own = scored.filter((c) => projectOfDir(c.d) === project);
      result = own.length === 1 ? own[0]!.d : null;
    }
    cache.set(key, result);
    return result;
  }) as ImportDirectoryResolver;
  resolver.exact = exact;
  return resolver;
}
