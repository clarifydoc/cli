import { posix } from "path";
import type { ConfigFileUse, FileAnalysis, SubProject } from "../types/analysis.js";

/**
 * Files the code opens by a path it spells out in literals (`FileAnalysis.filePathReads`), joined to the
 * file the analysis has at that path. Core names no language: a plugin states the literal parts, this
 * resolves them — beside the reading file, then at its sub-project's root, then at the analysis root, the
 * first file the analysis has, never by file name alone. A target that declares functions or classes is
 * code, not configuration; a path that leaves the analysis or is absolute resolves nowhere.
 */
const MAX_CONSUMERS = 50;

export function joinConfigFiles(
  analyses: readonly FileAnalysis[],
  subProjects: readonly SubProject[],
  isAuthored: (file: string) => boolean,
  isTest: (file: string, language: FileAnalysis["language"]) => boolean,
): ConfigFileUse[] {
  const byPath = new Map<string, FileAnalysis>();
  const rows = new Map<string, ConfigFileUse>();
  let any = false;
  for (const a of analyses) {
    byPath.set(a.filePath, a);
    if (a.filePathReads?.length) any = true;
  }
  if (!any) return [];
  const rootOf = new Map(subProjects.map((p) => [p.id, p.root.replace(/^\.$/, "").replace(/\/+$/, "")]));
  for (const a of analyses) {
    if (!a.filePathReads?.length || !isAuthored(a.filePath) || isTest(a.filePath, a.language)) continue;
    for (const read of a.filePathReads) {
      const rel = relativePath(read.parts);
      if (!rel) continue;
      const dir = posix.dirname(a.filePath);
      const bases = read.anchor === "file" ? [dir] : [dir, rootOf.get(a.projectId ?? "") ?? "", ""];
      let target: FileAnalysis | undefined;
      for (const base of bases) {
        const candidate = posix.normalize(base && base !== "." ? `${base}/${rel}` : rel);
        if (candidate.startsWith("../") || candidate === "..") continue;
        const hit = byPath.get(candidate);
        if (hit) { target = hit; break; }
      }
      if (!target || target.filePath === a.filePath || target.functions.length > 0 || target.classes.length > 0) continue;
      const row = rows.get(target.filePath) ?? rows.set(target.filePath, {
        file: target.filePath,
        ...(target.projectId ? { project: target.projectId } : {}),
        consumers: [],
      }).get(target.filePath)!;
      if (row.consumers.length < MAX_CONSUMERS && !row.consumers.some((c) => c.file === a.filePath && c.line === read.line)) {
        row.consumers.push({ file: a.filePath, line: read.line, ...(a.projectId ? { project: a.projectId } : {}) });
      }
    }
  }
  return [...rows.values()].sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
}

/** The parts as one relative path, or null when it is absolute, a URL, home-relative or has a hole. */
function relativePath(parts: readonly string[]): string | null {
  if (parts.length === 0) return null;
  const joined = parts.map((p) => p.replace(/\\/g, "/")).join("/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
  if (!joined || /^(?:\/|~|[A-Za-z]:|[A-Za-z][\w+.-]*:\/\/)/.test(joined) || /[${}*?]/.test(joined)) return null;
  return joined;
}
