import type { FileAnalysis } from "../types/analysis.js";
import type { ClassIndex, ImportIndex, ModuleValueLookup } from "../types/project.js";
import { extensionFamily } from "../extractors/plugins/shared/path-utils.js";
import { importsNameDirectories, pluginFor } from "../extractors/registry.js";
import { buildImportDirectoryResolver } from "./import-directories.js";
import { isTestFile } from "./test-file-detector.js";

/**
 * The string value a name stands for, followed into the module that defines
 * it. Plugins report two facts and never resolve across files themselves:
 *
 *   - `FileAnalysis.moduleValues`: the string values a module defines at its
 *     top level, by name (`const ApiUri = "/api/v1"`, `export const
 *     CLUBS_URL = '/api/v2/clubs'`, an object's members as `name.member`);
 *   - the reference at the use site, as written (`config.ApiUri`, `kafka.Topic`,
 *     `CLUBS_URL`): a `${…}` hole in a URL, or `DataSourceInfo.targetRef`.
 *
 * A name resolves, in order, in the file itself; in the file an import binds
 * its head to (a named import keys by the whole name, a namespace import by
 * the member after it); in the package an import names where imports name
 * directories (`importsNameDirectories`: the files of the one directory the
 * import path ends with, as the component graph resolves it); and, for a bare
 * name where a directory is one scope (`directoryScope`), in the other files
 * of the caller's own directory; and, for `Type.member`, in the project class
 * the type name resolves to as the class index resolves a type from the
 * caller (an import, the caller's own package, a namespace it uses) — a
 * class's own constants (`ClassInfo.fieldValues`: `static final String`,
 * `const string`, a class attribute), a bare name inside the class's file
 * reading the same. Candidates stay in the caller's
 * language family, and production code never takes a value from a test file.
 * Two different values for one name decide nothing. A value that itself holds
 * holes (`DownloadUri = ApiUri + "/dl"` → `${ApiUri}/dl`) is resolved in the
 * file that defines it, a few levels deep; what stays unknown stays a hole.
 */
export type { ModuleValueLookup };

const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const HOLE = /\$\{([^{}]*)\}/g;

export function buildModuleValueLookup(
  analyses: readonly FileAnalysis[],
  importIndex: ImportIndex,
  classes?: ClassIndex,
  /** The package-import resolver the project shares (built from `analyses` alone when absent). */
  sharedImportDirectory?: (source: string, fromFile: string) => string | null,
): ModuleValueLookup {
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  let filesByDir: Map<string, FileAnalysis[]> | null = null;
  const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const filesIn = (dir: string): FileAnalysis[] => {
    if (!filesByDir) {
      filesByDir = new Map();
      for (const a of analyses) {
        if (!a.moduleValues) continue;
        const d = dirOf(a.filePath);
        (filesByDir.get(d) ?? filesByDir.set(d, []).get(d)!).push(a);
      }
    }
    return filesByDir.get(dir) ?? [];
  };
  let importDirectory: ((source: string, fromFile: string) => string | null) | null = sharedImportDirectory ?? null;

  /** One value among the files that define `key`, or null when none or several differ. */
  const unique = (files: readonly FileAnalysis[], key: string, from: FileAnalysis): { value: string; file: string } | null => {
    const fromTest = isTestFile(from.filePath, from.language);
    const family = extensionFamily(from.filePath);
    let found: { value: string; file: string } | null = null;
    for (const f of files) {
      if (f.filePath === from.filePath) continue;
      if (extensionFamily(f.filePath) !== family) continue;
      if (!fromTest && isTestFile(f.filePath, f.language)) continue;
      const v = f.moduleValues?.[key];
      if (v === undefined) continue;
      if (found && found.value !== v) return null;
      found ??= { value: v, file: f.filePath };
    }
    return found;
  };

  let qualified: Map<string, { filePath: string; cls: FileAnalysis["classes"][number] } | null> | null = null;
  const qualifiedClass = (name: string) => {
    if (!qualified) {
      qualified = new Map();
      for (const f of analyses) {
        for (const cls of f.classes) {
          if (!cls.name.includes(".")) continue;
          qualified.set(cls.name, qualified.has(cls.name) ? null : { filePath: f.filePath, cls });
        }
      }
    }
    return qualified.get(name) ?? null;
  };

  /** `Type.member` (or a bare member inside the type's own file): a constant of the project class the name resolves to. */
  const classConstant = (a: FileAnalysis, expr: string): { value: string; file: string } | null => {
    if (!classes) return null;
    const dot = expr.lastIndexOf(".");
    if (dot < 0) {
      // A bare name in a class's own file: one of its classes states it.
      let found: string | undefined;
      for (const ref of classes.classesIn(a.filePath)) {
        const v = ref.cls.fieldValues?.[expr];
        if (v === undefined) continue;
        if (found !== undefined && found !== v) return null;
        found = v;
      }
      return found === undefined ? null : { value: found, file: a.filePath };
    }
    const type = expr.slice(0, dot);
    const member = expr.slice(dot + 1);
    const resolved = classes.resolve(a.filePath, type);
    // A module named in full (`App.Storage`, as a language whose module names are global
    // writes it) is the one class of exactly that name.
    const last = (t: string) => t.slice(t.lastIndexOf(".") + 1);
    const ref = resolved && last(resolved.cls.name) === last(type)
      ? resolved
      : type.includes(".") ? qualifiedClass(type) : null;
    if (!ref) return null;
    const target = byFile.get(ref.filePath);
    if (!target || extensionFamily(target.filePath) !== extensionFamily(a.filePath)) return null;
    if (!isTestFile(a.filePath, a.language) && isTestFile(target.filePath, target.language)) return null;
    const v = target.moduleValues?.[`${ref.cls.name}.${member}`] ?? ref.cls.fieldValues?.[member];
    if (v !== undefined) return { value: v, file: target.filePath };
    // A type whose declaration and methods sit in several files of its package (Go): the
    // value is in whichever of them states it (`frontendServer.ordersAddr`, set in main.go).
    if (!pluginFor(target.language)?.typesSpanFiles) return null;
    for (const f of filesIn(dirOf(target.filePath))) {
      if (f.filePath === target.filePath || !f.classes.some((c) => c.name === ref.cls.name)) continue;
      const w = f.moduleValues?.[`${ref.cls.name}.${member}`];
      if (w !== undefined) return { value: w, file: f.filePath };
    }
    return null;
  };

  const find = (fromFile: string, expr: string): { value: string; file: string } | null => {
    const a = byFile.get(fromFile);
    if (!a || !NAME.test(expr)) return null;
    return findIn(a, fromFile, expr) ?? classConstant(a, expr);
  };

  const findIn = (a: FileAnalysis, fromFile: string, expr: string): { value: string; file: string } | null => {
    const own = a.moduleValues?.[expr];
    if (own !== undefined) return { value: own, file: fromFile };
    const dot = expr.indexOf(".");
    const head = dot < 0 ? expr : expr.slice(0, dot);
    const rest = dot < 0 ? null : expr.slice(dot + 1);
    const imp = (a.imports ?? []).find((i) => !i.executes && i.specifiers.includes(head));
    const source = importIndex.localFor(fromFile, head);
    if (imp && source && source !== fromFile) {
      const mod = byFile.get(source)?.moduleValues;
      const exported = imp.aliases?.[head];
      const key = exported ? (rest ? `${exported}.${rest}` : exported) : expr;
      // `from tests.utils import api_routes` binds the module itself (a file or a package named
      // like the binding): `api_routes.clubs_url` is that module's `clubs_url`.
      const segs = source.replace(/\.[^./]+$/, "").split("/");
      const named = exported ?? head;
      const isModule = segs[segs.length - 1] === named || segs[segs.length - 2] === named;
      const v = mod?.[key] ?? ((imp.isNamespace || isModule) && rest ? mod?.[rest] : undefined);
      return v === undefined ? null : { value: v, file: source };
    }
    // A package import: the import path names a directory, whose files share one scope.
    if (imp && rest && importsNameDirectories(a.language)) {
      const dir = (importDirectory ??= buildImportDirectoryResolver(analyses))(imp.source, fromFile);
      return dir === null ? null : unique(filesIn(dir), rest, a);
    }
    // A bare name another file of the caller's own package defines.
    return !imp && !rest && pluginFor(a.language)?.directoryScope ? unique(filesIn(dirOf(fromFile)), expr, a) : null;
  };

  const resolve = (fromFile: string, expr: string, depth: number): string | null => {
    const hit = find(fromFile, expr);
    if (!hit) return null;
    if (depth >= 4 || !hit.value.includes("${")) return hit.value;
    return hit.value.replace(HOLE, (hole, inner: string) => resolve(hit.file, inner.trim(), depth + 1) ?? hole);
  };
  const lookup = ((fromFile: string, expr: string) => resolve(fromFile, expr.trim(), 0)) as ModuleValueLookup;
  lookup.locate = (fromFile, expr) => find(fromFile, expr.trim());
  return lookup;
}

/**
 * Data-source rows whose target is a name another module defines
 * (`DataSourceInfo.targetRef`: a topic in another package's constant) take
 * that value. Returns the number of rows resolved.
 */
export function resolveTargetRefs(analyses: readonly FileAnalysis[], lookup: ModuleValueLookup): number {
  let n = 0;
  for (const a of analyses) {
    for (const ds of a.dataSources ?? []) {
      if (!ds.targetRef) continue;
      const v = lookup(a.filePath, ds.targetRef);
      // A table named by a value nothing states is no entity of that name.
      const named = ds.kind === "database" && ds.entity === ds.targetRef;
      if (v === null || v.includes("${")) {
        if (named) delete ds.entity;
        continue;
      }
      ds.target = v;
      if (named) ds.entity = v;
      n++;
    }
  }
  return n;
}

/**
 * Routes whose path names another module's constants (`RouteInfo.pathTemplate`:
 * `@GetMapping(ApiPaths.CLUB)` → `${ApiPaths.CLUB}`) take the path the
 * defining modules state, when they state every hole. Returns the number of
 * routes resolved.
 */
export function resolveRouteTemplates(analyses: readonly FileAnalysis[], lookup: ModuleValueLookup): number {
  let n = 0;
  for (const a of analyses) {
    for (const r of a.routes ?? []) {
      if (!r.pathTemplate) continue;
      let unresolved = false;
      const path = r.pathTemplate.replace(HOLE, (_hole, inner: string) => {
        const v = lookup(a.filePath, inner.trim());
        if (v === null || v.includes("${")) unresolved = true;
        return v ?? "";
      });
      if (unresolved) continue;
      // A parameter's constraint or default in the constant (`{id:int}`, `{page?}`) is no part of the path.
      const joined = ("/" + path).replace(/\/{2,}/g, "/").replace(/\{(\*{0,2})([^}:=?]+)[:=?][^}]*\}/g, (_m, star: string, name: string) => `{${star ? "*" : ""}${name}}`);
      r.path = joined.length > 1 ? joined.replace(/\/$/, "") : joined;
      n++;
    }
  }
  return n;
}
