import type { FileAnalysis } from "../types/analysis.js";
import type { ClassIndex, ClassRef, ImportIndex, SupertypeRef } from "../types/project.js";
import { closestByDir } from "./symbol-linker.js";
import { bareSupertypeName, declaredSupertypes, sameTypeSpace } from "./typed-receivers.js";

/** How deep `ancestors` follows a chain before giving up — real hierarchies are far shallower. */
const MAX_DEPTH = 8;

/**
 * Resolve a type NAME to the one project file that defines it, seen from a
 * declaring file — or null when no definition qualifies or several tie.
 *
 * A candidate must live in the declaring file's type space (same language
 * family, or same language where there is no family); a same-language one
 * beats a family homonym (Kotlin beside Java); then the declaring file's own
 * sub-project wins, the closest by directory when it holds several; otherwise
 * only a definition unique across the type space counts.
 *
 * `includeExports` also counts exported interfaces/classes a plugin did not
 * model as a ClassInfo. `allowOwnFile: false` reports a name the declaring file
 * itself defines as unresolved — what the inheritance edge pass wants, since an
 * edge to oneself is no edge.
 */
export function createTypeResolver(
  analyses: readonly FileAnalysis[],
  { includeExports = false, allowOwnFile = true }: { includeExports?: boolean; allowOwnFile?: boolean } = {},
): (name: string, from: FileAnalysis) => string | null {
  const definitions = new Map<string, string[]>();
  const define = (name: string, file: string): void => {
    const list = definitions.get(name);
    if (!list) definitions.set(name, [file]);
    else if (!list.includes(file)) list.push(file);
  };
  for (const a of analyses) {
    for (const cls of a.classes) define(cls.name, a.filePath);
    if (includeExports) {
      for (const exp of a.exports) {
        if (exp.kind === "interface" || exp.kind === "class") define(exp.name, a.filePath);
      }
    }
  }
  const projectOf = new Map(analyses.map((a) => [a.filePath, a.projectId]));
  const languageOf = new Map(analyses.map((a) => [a.filePath, a.language as string]));

  return (name, from) => {
    let candidates = (definitions.get(name) ?? []).filter((f) =>
      sameTypeSpace(from.filePath, from.language, f, languageOf.get(f) ?? ""),
    );
    if (candidates.length === 0) return null;
    if (candidates.includes(from.filePath)) return allowOwnFile ? from.filePath : null;
    const sameLang = candidates.filter((f) => languageOf.get(f) === from.language);
    if (sameLang.length > 0) candidates = sameLang;
    const own = candidates.filter((f) => projectOf.get(f) === from.projectId);
    if (own.length > 0) return own.length === 1 ? own[0]! : closestByDir(own, from.filePath, (f) => f);
    return candidates.length === 1 ? candidates[0]! : null;
  };
}

/**
 * Build the project's class index (see `ClassIndex`). Resolution order for a
 * supertype as written in file F: a class of that name in F; the file an
 * import binding of the name — or of its qualifier, `viewsets.ModelViewSet` —
 * resolves to; then `createTypeResolver`'s type-space rules.
 */
export function buildClassIndex(analyses: readonly FileAnalysis[], importIndex: ImportIndex): ClassIndex {
  const byFile = new Map<string, FileAnalysis>(analyses.map((a) => [a.filePath, a]));
  const refsByFile = new Map<string, ClassRef[]>();
  for (const a of analyses) {
    if (a.classes.length === 0) continue;
    refsByFile.set(
      a.filePath,
      a.classes.map((cls) => ({ filePath: a.filePath, projectId: a.projectId ?? "root", language: a.language, cls })),
    );
  }
  const typeFile = createTypeResolver(analyses);
  const classNamed = (file: string, name: string): ClassRef | null =>
    refsByFile.get(file)?.find((r) => r.cls.name === name) ?? null;

  const resolve = (fromFile: string, written: string): ClassRef | null => {
    const name = bareSupertypeName(written);
    if (!name) return null;
    const own = classNamed(fromFile, name);
    if (own) return own;
    // An import binding names the file: `from .base import BaseViewSet`, or a
    // module alias qualifying the name (`base.BaseViewSet`, `import base`).
    const head = written.replace(/[<[(].*$/s, "").trim().split(/\\|::|\./)[0] ?? "";
    for (const binding of new Set([name, head])) {
      if (!binding) continue;
      const file = importIndex.localFor(fromFile, binding);
      if (file) {
        const hit = classNamed(file, name);
        if (hit) return hit;
      }
    }
    const from = byFile.get(fromFile);
    if (!from) return null;
    // A name the file imports from elsewhere (a package) is that package's.
    if (importIndex.sourceFor(fromFile, name) && !importIndex.localFor(fromFile, name)) return null;
    const file = typeFile(name, from);
    return file ? classNamed(file, name) : null;
  };

  const supertypeMemo = new Map<ClassRef, SupertypeRef[]>();
  const supertypes = (ref: ClassRef): SupertypeRef[] => {
    const cached = supertypeMemo.get(ref);
    if (cached) return cached;
    const a = byFile.get(ref.filePath);
    const out: SupertypeRef[] = [];
    if (a) {
      for (const written of declaredSupertypes(ref.cls, a)) {
        const name = bareSupertypeName(written);
        if (!name) continue;
        const target = resolve(ref.filePath, written);
        const head = written.replace(/[<[(].*$/s, "").trim().split(/\\|::|\./)[0] ?? "";
        out.push({
          written,
          name,
          ref: target && target !== ref ? target : null,
          importSource: importIndex.sourceFor(ref.filePath, name) ?? importIndex.sourceFor(ref.filePath, head),
        });
      }
    }
    supertypeMemo.set(ref, out);
    return out;
  };

  const ancestors = (ref: ClassRef): SupertypeRef[] => {
    const out: SupertypeRef[] = [];
    const seenRefs = new Set<ClassRef>([ref]);
    const seenNames = new Set<string>();
    const visit = (r: ClassRef, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      for (const s of supertypes(r)) {
        if (s.ref) {
          if (seenRefs.has(s.ref)) continue;
          seenRefs.add(s.ref);
          out.push(s);
          visit(s.ref, depth + 1);
        } else if (!seenNames.has(s.written)) {
          seenNames.add(s.written);
          out.push(s);
        }
      }
    };
    visit(ref, 1);
    return out;
  };

  let childrenOf: Map<ClassRef, ClassRef[]> | null = null;
  const descendants = (ref: ClassRef): ClassRef[] => {
    if (!childrenOf) {
      childrenOf = new Map();
      for (const refs of refsByFile.values()) {
        for (const r of refs) {
          for (const s of supertypes(r)) {
            if (!s.ref) continue;
            const list = childrenOf.get(s.ref) ?? [];
            list.push(r);
            childrenOf.set(s.ref, list);
          }
        }
      }
    }
    const out: ClassRef[] = [];
    const seen = new Set<ClassRef>([ref]);
    const queue = [ref];
    while (queue.length) {
      for (const child of childrenOf.get(queue.shift()!) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        queue.push(child);
      }
    }
    return out;
  };

  return {
    resolve,
    classesIn: (file) => refsByFile.get(file) ?? [],
    supertypes,
    ancestors,
    descendants,
  };
}
