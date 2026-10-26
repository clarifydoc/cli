import type { FileAnalysis } from "../types/analysis.js";
import type { ImportIndex, ModuleValueLookup } from "../types/project.js";
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
 * of the caller's own directory. Candidates stay in the caller's
 * language family, and production code never takes a value from a test file.
 * Two different values for one name decide nothing. A value that itself holds
 * holes (`DownloadUri = ApiUri + "/dl"` → `${ApiUri}/dl`) is resolved in the
 * file that defines it, a few levels deep; what stays unknown stays a hole.
 */
export type { ModuleValueLookup };

const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const HOLE = /\$\{([^{}]*)\}/g;

export function buildModuleValueLookup(analyses: readonly FileAnalysis[], importIndex: ImportIndex): ModuleValueLookup {
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
  let importDirectory: ((source: string, fromFile: string) => string | null) | null = null;

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

  const find = (fromFile: string, expr: string): { value: string; file: string } | null => {
    const a = byFile.get(fromFile);
    if (!a || !NAME.test(expr)) return null;
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
      const v = mod?.[key] ?? (imp.isNamespace && rest ? mod?.[rest] : undefined);
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
      if (v === null || v.includes("${")) continue;
      ds.target = v;
      n++;
    }
  }
  return n;
}
