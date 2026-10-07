import type { FileAnalysis } from "../types/analysis.js";
import { createTypeResolver } from "./class-index.js";
import { bareSupertypeName, declaredSupertypes } from "./typed-receivers.js";

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
  const resolve = createTypeResolver(analyses, { includeExports: true, allowOwnFile: false });

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
