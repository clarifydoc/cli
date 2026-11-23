import type { ClassInfo, FieldWriteRow, FileAnalysis, FunctionInfo, ThrownTypeRow } from "../types/analysis.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { manifestFor } from "../extractors/registry.js";
import { declaresEvidenceName, evidenceFullName } from "./class-evidence.js";

/**
 * Field writes and thrown exception types, resolved to project classes (`ProjectAnalysis.fieldWrites` /
 * `thrownTypes`) from the per-function facts (`FunctionInfo.fieldWrites` / `throws`). A plugin states the receiver as
 * written; this pass decides the class from DECLARED types only — the enclosing class (`this`, a bare field), a
 * parameter's type, a local's stated type, or the declared type of a field of the enclosing class — and a class name
 * binds only where exactly one class of that name is in reach (the writer's own file, else its sub-project, else the
 * project). A receiver no declaration types states nothing, so a namesake field of another class is never listed.
 */

interface ClassRef { cls: ClassInfo; file: string; project: string }

const MAX_HOPS = 8;

type LanguageName = Parameters<typeof manifestFor>[0];

export function joinMemberEffects(
  analyses: readonly FileAnalysis[],
  include: (file: string) => boolean = () => true,
): { fieldWrites: FieldWriteRow[]; thrownTypes: ThrownTypeRow[] } {
  const byName = new Map<string, ClassRef[]>();
  for (const a of analyses) {
    if (!include(a.filePath)) continue;
    for (const cls of a.classes) {
      const list = byName.get(cls.name) ?? [];
      list.push({ cls, file: a.filePath, project: a.projectId ?? "" });
      byName.set(cls.name, list);
    }
  }
  const analysisByFile = new Map(analyses.map((a) => [a.filePath, a]));
  const leaf = (name: string, sep?: string): string => name.slice(Math.max(name.lastIndexOf("."), name.lastIndexOf(":"), sep ? name.lastIndexOf(sep) : -1) + 1);

  /**
   * The one class `name` means from `nearFile`: its own file's, else its sub-project's, else the project's only one.
   * Where classes are looked up by namespace (`classNamesByEvidence`) the candidates are first narrowed to the
   * namespace the writing file's own evidence names (an import, its namespace, a full name), never a namesake's.
   */
  const locate = (name: string, nearFile: string, project: string, line = 0): ClassRef | null => {
    const from = analysisByFile.get(nearFile);
    const sep = from ? manifestFor(from.language as LanguageName)?.classNamesByEvidence?.separator : undefined;
    let all = byName.get(sep ? leaf(name, sep) : name) ?? byName.get(leaf(name));
    if (!all) return null;
    if (sep && from) {
      const simple = leaf(name, sep).toLowerCase();
      const full = evidenceFullName(from, sep, name, line);
      all = all.filter((c) => (c.file === nearFile && !name.includes(sep)) || declaresEvidenceName(analysisByFile.get(c.file), sep, simple, full));
      if (all.length === 0) return null;
    }
    const own = all.filter((c) => c.file === nearFile);
    if (own.length > 0) return own.length === 1 ? own[0]! : null;
    const sameProject = all.filter((c) => c.project === project);
    if (sameProject.length > 0) return sameProject.length === 1 ? sameProject[0]! : null;
    return all.length === 1 ? all[0]! : null;
  };

  /** Members a class's initializers assign through `this` (`FieldWrite.init`): declared by assignment, in a language with no field declarations. */
  const initDeclared = new Map<ClassInfo, Set<string>>();
  const initMembers = (cls: ClassInfo): ReadonlySet<string> => {
    let set = initDeclared.get(cls);
    if (!set) {
      set = new Set();
      for (const m of cls.methods) for (const w of m.fieldWrites ?? []) if (w.init && w.receiver === "this") set.add(w.member);
      initDeclared.set(cls, set);
    }
    return set;
  };

  /** The class in `ref`'s own or base chain that declares property `member` (itself when it does). */
  const declaring = (ref: ClassRef): ((member: string) => { ref: ClassRef; type?: string } | null) => (member) => {
    const seen = new Set<ClassInfo>();
    let at: ClassRef | null = ref;
    for (let hop = 0; at && hop < MAX_HOPS && !seen.has(at.cls); hop++) {
      seen.add(at.cls);
      const prop = at.cls.properties?.find((p) => p.name === member);
      if (prop) return { ref: at, ...(prop.type ? { type: prop.type } : {}) };
      if (initMembers(at.cls).has(member)) return { ref: at };
      at = at.cls.extends ? locate(at.cls.extends, at.file, at.project, at.cls.line) : null;
    }
    return null;
  };

  const fieldWrites: FieldWriteRow[] = [];
  const thrownTypes: ThrownTypeRow[] = [];

  const visit = (a: FileAnalysis, fn: FunctionInfo, symbol: string, owner: ClassRef | null): void => {
    const project = a.projectId ?? "";
    const typeOfName = (name: string): string | null => {
      const param = fn.params.find((p) => p.name === name);
      if (param) return receiverTypeName(param.type, a.language);
      const locals = (fn.localTypes ?? []).filter((l) => l.name === name);
      if (locals.length === 0 || locals.some((l) => !l.type || l.choice !== undefined || l.soft)) return null;
      const types = new Set(locals.map((l) => receiverTypeName(l.type, a.language)));
      const only = [...types];
      return only.length === 1 ? only[0] ?? null : null;
    };
    for (const w of fn.fieldWrites ?? []) {
      if (w.init) continue;
      let target: ClassRef | null = null;
      let via: FieldWriteRow["via"] = "typed";
      if (w.receiver === "this" && owner) {
        via = "this";
        target = declaring(owner)(w.member)?.ref ?? owner;
      } else if (w.receiver === "" && owner) {
        via = "this";
        target = declaring(owner)(w.member)?.ref ?? null;
      } else if (w.receiver.startsWith("this.") && owner) {
        const field = declaring(owner)(w.receiver.slice(5));
        const type = field?.type ? receiverTypeName(field.type, a.language) : null;
        const typed = type ? locate(type, field!.ref.file, field!.ref.project, field!.ref.cls.line) : null;
        target = typed ? declaring(typed)(w.member)?.ref ?? null : null;
      } else if (w.receiver && !w.receiver.includes(".") && w.receiver !== "this") {
        const type = typeOfName(w.receiver);
        const typed = type ? locate(type, a.filePath, project, w.line) : null;
        target = typed ? declaring(typed)(w.member)?.ref ?? null : null;
      }
      if (!target) continue;
      fieldWrites.push({ class: target.cls.name, classFile: target.file, member: w.member, function: symbol, file: a.filePath, line: w.line, via });
    }
    for (const t of fn.throws ?? []) {
      const known = locate(t.type, a.filePath, project, t.line);
      thrownTypes.push({ type: t.type, function: symbol, file: a.filePath, line: t.line, ...(t.declared ? { declared: true as const } : {}), ...(known ? { classFile: known.file } : {}) });
    }
  };

  for (const a of analyses) {
    if (!include(a.filePath)) continue;
    for (const cls of a.classes) {
      const owner: ClassRef = { cls, file: a.filePath, project: a.projectId ?? "" };
      for (const m of cls.methods) if (m.fieldWrites || m.throws) visit(a, m, `${cls.name}.${m.name}`, owner);
    }
    for (const fn of a.functions) if (fn.fieldWrites || fn.throws) visit(a, fn, fn.name, null);
  }
  const order = (x: { file: string; line: number; function: string }, y: { file: string; line: number; function: string }): number =>
    x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line || (x.function < y.function ? -1 : x.function > y.function ? 1 : 0);
  fieldWrites.sort(order);
  thrownTypes.sort(order);
  return { fieldWrites, thrownTypes };
}
