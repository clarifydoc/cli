import type { ClassInfo, FieldWriteRow, FileAnalysis, FunctionInfo, ThrownTypeRow } from "../types/analysis.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";

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

export function joinMemberEffects(
  analyses: readonly FileAnalysis[],
  include: (file: string) => boolean = () => true,
): { fieldWrites: FieldWriteRow[]; thrownTypes: ThrownTypeRow[] } {
  const byName = new Map<string, ClassRef[]>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      const list = byName.get(cls.name) ?? [];
      list.push({ cls, file: a.filePath, project: a.projectId ?? "" });
      byName.set(cls.name, list);
    }
  }
  const leaf = (name: string): string => name.slice(Math.max(name.lastIndexOf("."), name.lastIndexOf(":")) + 1);

  /** The one class `name` means from `nearFile`: its own file's, else its sub-project's, else the project's only one. */
  const locate = (name: string, nearFile: string, project: string): ClassRef | null => {
    const all = byName.get(name) ?? byName.get(leaf(name));
    if (!all) return null;
    const own = all.filter((c) => c.file === nearFile);
    if (own.length > 0) return own.length === 1 ? own[0]! : null;
    const sameProject = all.filter((c) => c.project === project);
    if (sameProject.length > 0) return sameProject.length === 1 ? sameProject[0]! : null;
    return all.length === 1 ? all[0]! : null;
  };

  /** The class in `ref`'s own or base chain that declares property `member` (itself when it does). */
  const declaring = (ref: ClassRef): ((member: string) => { ref: ClassRef; type?: string } | null) => (member) => {
    const seen = new Set<ClassInfo>();
    let at: ClassRef | null = ref;
    for (let hop = 0; at && hop < MAX_HOPS && !seen.has(at.cls); hop++) {
      seen.add(at.cls);
      const prop = at.cls.properties?.find((p) => p.name === member);
      if (prop) return { ref: at, ...(prop.type ? { type: prop.type } : {}) };
      at = at.cls.extends ? locate(at.cls.extends, at.file, at.project) : null;
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
        const typed = type ? locate(type, field!.ref.file, field!.ref.project) : null;
        target = typed ? declaring(typed)(w.member)?.ref ?? typed : null;
      } else if (w.receiver && !w.receiver.includes(".") && w.receiver !== "this") {
        const type = typeOfName(w.receiver);
        const typed = type ? locate(type, a.filePath, project) : null;
        target = typed ? declaring(typed)(w.member)?.ref ?? typed : null;
      }
      if (!target) continue;
      fieldWrites.push({ class: target.cls.name, classFile: target.file, member: w.member, function: symbol, file: a.filePath, line: w.line, via });
    }
    for (const t of fn.throws ?? []) {
      const known = locate(t.type, a.filePath, project);
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
