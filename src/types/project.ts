import type { ClassInfo, FileAnalysis, Language } from "./analysis.js";

/**
 * Project-wide import lookups, built once after per-file extraction. Lives in
 * types (not core) because plugin-contributed project passes receive it: a
 * plugin may consume core's facts, never import core.
 *
 *   - localFor(file, name): the project file `name` was imported from, if the
 *     import resolves to one.
 *   - sourceFor(file, name): the raw import source `name` came from (a bare
 *     package, a relative path, an alias).
 *   - namespacesFor(file): sources imported without a binding name (C#
 *     `using`, Java `import x.*`, Python `from x import *`).
 */
export interface ImportIndex {
  localFor(file: string, name: string): string | null;
  sourceFor(file: string, name: string): string | null;
  namespacesFor(file: string): string[];
  /** The project file an import of `source` in `file` loads — any import of it, bound or not. */
  fileForSource?(file: string, source: string): string | null;
}

/** A class as declared in one file. */
export interface ClassRef {
  filePath: string;
  projectId: string;
  language: Language;
  cls: ClassInfo;
}

/** One supertype a class names, resolved to a project class when it is one. */
export interface SupertypeRef {
  /** As written: `ModelViewSet[Tag]`, `viewsets.ModelViewSet`, `BaseApiController`. */
  written: string;
  /** Simple name: `ModelViewSet`. */
  name: string;
  /** The project class it names, or null for a framework / third-party type. */
  ref: ClassRef | null;
  /** Import source of the name in the declaring file (`rest_framework.viewsets`), when imported. */
  importSource: string | null;
}

/**
 * Classes across the project, with supertypes resolved the way the import
 * graph and the type space allow: the declaring file, then an import binding,
 * then the one definition in the class's own sub-project (or the closest of
 * several by directory), then a definition unique across the language family.
 * A tie resolves to nothing — never to a guess.
 */
export interface ClassIndex {
  /** The project class `written` names when seen from `fromFile`. */
  resolve(fromFile: string, written: string): ClassRef | null;
  /** Classes declared in a file. */
  classesIn(file: string): ClassRef[];
  /** Direct supertypes, `extends` first, in declaration order. */
  supertypes(ref: ClassRef): SupertypeRef[];
  /** Every supertype reachable, depth-first left-to-right, each once; cycle-safe and depth-capped. */
  ancestors(ref: ClassRef): SupertypeRef[];
  /** Every project class that has `ref` among its ancestors. */
  descendants(ref: ClassRef): ClassRef[];
}

/**
 * What a plugin's project-level pass may consult. Built once by the analyzer
 * after per-file extraction; every lookup is read-only.
 */
export interface ProjectContext {
  readonly importIndex: ImportIndex;
  readonly classes: ClassIndex;
  /** A module specifier as written (`./auth`, `dcim.api.urls`) → the project file it names, or null. */
  resolveModule(fromFile: string, specifier: string): string | null;
  fileOf(path: string): FileAnalysis | undefined;
}
