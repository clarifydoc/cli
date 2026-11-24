import { lstat } from "fs/promises";
import { insideRoot } from "./inside-root.js";
import { join, posix, resolve } from "path";
import { isSensitive } from "./file-discovery.js";
import { isIgnored, loadIgnorePatterns } from "./clarifydoc-ignore.js";
import type { ConfigFileUse, FileAnalysis, SubProject } from "../types/analysis.js";

/**
 * Files the code opens by a path it spells out in literals (`FileAnalysis.filePathReads`), joined to the
 * file the analysis has at that path. Core names no language: a plugin states the literal parts, this
 * resolves them (`exists`: an analyzed file or one on disk) — beside the reading file, then at its sub-project's root, then at the analysis root, the
 * first file that exists, never by file name alone. A target that declares functions or classes, imports or draws a template is
 * code, not configuration; a path that leaves the analysis or is absolute resolves nowhere.
 */
const MAX_CONSUMERS = 50;

export async function joinConfigFiles(
  analyses: readonly FileAnalysis[],
  subProjects: readonly SubProject[],
  isAuthored: (file: string) => boolean,
  isTest: (file: string, language: FileAnalysis["language"]) => boolean,
  exists: (file: string) => Promise<boolean>,
): Promise<ConfigFileUse[]> {
  const byPath = new Map<string, FileAnalysis>();
  const rows = new Map<string, ConfigFileUse>();
  let any = false;
  for (const a of analyses) {
    byPath.set(a.filePath, a);
    if (a.filePathReads?.length) any = true;
  }
  if (!any) return [];
  const rootOf = new Map(subProjects.map((p) => [p.id, p.root.replace(/^\.$/, "").replace(/\/+$/, "")]));
  // The innermost sub-project holding a file nothing analyzed (a config file).
  const innermost = (file: string): string | undefined => {
    let best: SubProject | undefined;
    for (const p of subProjects) {
      const root = rootOf.get(p.id) ?? "";
      if ((root === "" || file.startsWith(root + "/")) && (!best || root.length > (rootOf.get(best.id) ?? "").length)) best = p;
    }
    return best?.id;
  };
  for (const a of analyses) {
    if (!a.filePathReads?.length || !isAuthored(a.filePath) || isTest(a.filePath, a.language)) continue;
    for (const read of a.filePathReads) {
      const rel = relativePath(read.parts);
      if (!rel) continue;
      const dir = posix.dirname(a.filePath);
      const bases = read.anchor === "file" ? [dir] : [dir, rootOf.get(a.projectId ?? "") ?? "", ""];
      let target: string | undefined;
      for (const base of bases) {
        const candidate = posix.normalize(base && base !== "." ? `${base}/${rel}` : rel);
        if (candidate.startsWith("../") || candidate === "..") continue;
        if (byPath.has(candidate) || await exists(candidate)) { target = candidate; break; }
      }
      const analyzed = target ? byPath.get(target) : undefined;
      if (!target || target === a.filePath || (analyzed && (analyzed.functions.length > 0 || analyzed.classes.length > 0 || analyzed.imports.length > 0 || (analyzed.templateTree?.length ?? 0) > 0))) continue;
      const project = analyzed?.projectId ?? innermost(target);
      const row = rows.get(target) ?? rows.set(target, { file: target, ...(project ? { project } : {}), consumers: [] }).get(target)!;
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

/**
 * Whether a file the analysis did not read (a config file) is there: a regular file, never a link, never
 * a credential-looking name, never one a `.clarifydocignore` covers.
 */
export function diskFileExists(projectRoot: string): (file: string) => Promise<boolean> {
  const root = resolve(projectRoot);
  const ignore = loadIgnorePatterns(root);
  const seen = new Map<string, Promise<boolean>>();
  return (file) => {
    let hit = seen.get(file);
    if (!hit) {
      const abs = insideRoot(root, file) ?? join(root, file);
      hit = insideRoot(root, file) === null || isSensitive(file) || isIgnored(abs, root, ignore)
        ? Promise.resolve(false)
        : lstat(abs).then((st) => st.isFile(), () => false);
      seen.set(file, hit);
    }
    return hit;
  };
}
