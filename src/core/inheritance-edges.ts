import type { FileAnalysis } from "../types/analysis.js";
import { closestByDir } from "./symbol-linker.js";
import { bareSupertypeName, declaredSupertypes, sameTypeSpace } from "./typed-receivers.js";

/**
 * Add a dependency edge from every class file to the file defining the class
 * or interface it extends or implements, when no import says so.
 *
 * The component graph is built from imports, and a same-namespace or
 * same-package base needs none: a C# `class SqlRepo : IRepo` in the same
 * namespace, a Java/Kotlin/Go type in the same package, a PHP class beside its
 * interface. Without the edge an interface's blast radius missed exactly the
 * files a signature change breaks — its implementations.
 *
 * A base named by an import is left to import resolution (that edge exists,
 * or the base is external). Otherwise the base must resolve unambiguously:
 * the one definition of that name in the class's own sub-project (or the
 * closest of several by directory), else a definition unique across the
 * language family. A tie adds nothing. Returns the number of edges added.
 */
export function enrichGraphFromInheritance(
  graph: Record<string, string[]>,
  analyses: FileAnalysis[],
): number {
  const definitions = new Map<string, string[]>();
  const define = (name: string, file: string): void => {
    const list = definitions.get(name);
    if (!list) definitions.set(name, [file]);
    else if (!list.includes(file)) list.push(file);
  };
  for (const a of analyses) {
    for (const cls of a.classes) define(cls.name, a.filePath);
    for (const exp of a.exports) {
      if (exp.kind === "interface" || exp.kind === "class") define(exp.name, a.filePath);
    }
  }
  const projectOf = new Map(analyses.map((a) => [a.filePath, a.projectId]));
  const languageOf = new Map(analyses.map((a) => [a.filePath, a.language as string]));

  const resolve = (name: string, from: FileAnalysis): string | null => {
    let candidates = (definitions.get(name) ?? []).filter((f) =>
      sameTypeSpace(from.filePath, from.language, f, languageOf.get(f) ?? ""),
    );
    if (candidates.length === 0 || candidates.includes(from.filePath)) return null;
    // A same-family homonym in another language (Kotlin beside Java) is not it.
    const sameLang = candidates.filter((f) => languageOf.get(f) === from.language);
    if (sameLang.length > 0) candidates = sameLang;
    const own = candidates.filter((f) => projectOf.get(f) === from.projectId);
    if (own.length > 0) return own.length === 1 ? own[0]! : closestByDir(own, from.filePath, (f) => f);
    return candidates.length === 1 ? candidates[0]! : null;
  };

  let added = 0;
  for (const a of analyses) {
    if (a.classes.length === 0) continue;
    const imported = new Set<string>();
    for (const imp of a.imports) for (const spec of imp.specifiers) imported.add(spec);
    for (const cls of a.classes) {
      for (const raw of declaredSupertypes(cls, a)) {
        const name = bareSupertypeName(raw);
        if (!name || name === cls.name || imported.has(name)) continue;
        const target = resolve(name, a);
        if (!target) continue;
        const edges = (graph[a.filePath] ??= []);
        if (!edges.includes(target)) {
          edges.push(target);
          added++;
        }
      }
    }
  }
  return added;
}
