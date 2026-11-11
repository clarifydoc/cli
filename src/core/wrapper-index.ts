import type { FileAnalysis, FunctionInfo } from "../types/analysis.js";
import type { ImportIndex } from "../types/project.js";

/**
 * One import-resolved index behind both wrapper lookups — a request wrapper
 * (`expandRequestFactories`) and a URL builder (`resolveUrlBuilders`). A name a
 * file's code calls resolves in this order, and anything else stays unknown:
 *
 *   1. lexical — the caller's own file declares it;
 *   2. the import that binds it (renames and re-exports followed by the import index);
 *   3. the ONE top-level declaration of that name in the caller's sub-project
 *      (an import no resolver reads — a bundler's source-root path);
 *   otherwise null.
 *
 * A member wrapper (`receiver.callee`) is judged on EVERY definition of that
 * member the receiver can be: one that does not forward the URL refuses it.
 */
export interface WrapperIndex {
  /** The project file an import in `file` binds `name` from, and the name that file declares; null when none resolves. */
  importedFrom(file: string, name: string): { file: string; exported: string } | null;
  /** The files of `file`'s sub-project declaring a top-level function `name`. */
  declarationsInProject(file: string, name: string): string[];
  /** Every definition of `receiver.member` the receiver names in `file`: members of objects and of classes called `receiver`. */
  memberDefinitions(file: string, receiver: string, member: string): FunctionInfo[];
}

export function buildWrapperIndex(analyses: readonly FileAnalysis[], importIndex: ImportIndex): WrapperIndex {
  const byFile = new Map<string, FileAnalysis>(analyses.map((a) => [a.filePath, a]));
  // Top-level declarations by project + name, built on first use.
  let topLevel: Map<string, string[]> | null = null;
  const tops = (): Map<string, string[]> => {
    if (topLevel) return topLevel;
    const built = new Map<string, string[]>();
    for (const a of analyses) {
      const seen = new Set<string>();
      for (const fn of a.functions) {
        if (fn.name.includes(".") || seen.has(fn.name)) continue;
        seen.add(fn.name);
        const key = `${a.projectId}\0${fn.name}`;
        (built.get(key) ?? built.set(key, []).get(key)!).push(a.filePath);
      }
    }
    topLevel = built;
    return built;
  };
  return {
    importedFrom(file, name) {
      const target = importIndex.localFor(file, name);
      if (!target || !byFile.has(target)) return null;
      const imp = byFile.get(file)?.imports?.find((i) => i.aliases?.[name] !== undefined && (importIndex.fileForSource?.(file, i.source) ?? target) === target);
      return { file: target, exported: imp?.aliases?.[name] ?? name };
    },
    declarationsInProject(file, name) {
      return tops().get(`${byFile.get(file)?.projectId}\0${name}`) ?? [];
    },
    memberDefinitions(file, receiver, member) {
      const a = byFile.get(file);
      if (!a) return [];
      return [
        ...a.functions.filter((f) => f.name === `${receiver}.${member}`),
        ...a.classes.filter((c) => c.name.toLowerCase() === receiver.toLowerCase()).flatMap((c) => c.methods.filter((m) => m.name === member)),
      ];
    },
  };
}
