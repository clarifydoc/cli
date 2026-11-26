import type { ClassInfo, FieldReadRow, FieldWriteRow, FileAnalysis, FunctionInfo, ThrownTypeRow } from "../types/analysis.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { manifestFor } from "../extractors/registry.js";
import { importResolveContext } from "./import-index.js";
import { declaresEvidenceName, evidenceFullName } from "./class-evidence.js";

/**
 * Field writes and thrown exception types, resolved to project classes (`ProjectAnalysis.fieldWrites` /
 * `thrownTypes`) from the per-function facts (`FunctionInfo.fieldWrites` / `throws`). A plugin states the receiver as
 * written; this pass decides the class from DECLARED types only — the enclosing class (`this`, a bare field), a
 * parameter's type, a local's stated type, or the declared type of a field of the enclosing class — and a class name
 * binds only where exactly one class of that name is in reach (the writer's own file, else its sub-project, else the
 * project). A receiver no declaration types states nothing, so a namesake field of another class is never listed.
 */

/** `parts`: the other declarations of one type in its directory, where a type spans files (Go: the struct and the files holding its methods). */
interface ClassRef { cls: ClassInfo; file: string; project: string; parts?: ClassRef[] }

const MAX_HOPS = 8;

/** Does `language` declare one type across the files of a directory (`typesSpanFiles`)? */
/** The class a declared type names: its namespace path as written when the plugin states one that names the same class, else the bare name. */
const pathOr = (type: string | null | undefined, path: string | undefined, language: string): string | null => {
  const bare = receiverTypeName(type, language as LanguageName);
  return bare && path && receiverTypeName(path, language as LanguageName) === bare ? path : writtenTypeName(type, language);
};
const spansFiles = (language: string): boolean => manifestFor(language as LanguageName)?.typesSpanFiles === true;

/** The language family a file's language belongs to (its manifest's `family`, else the language itself). */
const familyOf = (language: string): string => manifestFor(language as LanguageName)?.family ?? language;
/** Does `language` look a type up beyond its directory (`typesBeyondDirectory`)? */
const beyondDirectory = (language: string): boolean => manifestFor(language as LanguageName)?.typesBeyondDirectory === true;

/** `receiverTypeName`, with the qualifier the type was written through kept (`std::io::Error`, not `Error`): core asks whether a project backs it. */
const writtenTypeName = (raw: string | null | undefined, language: string): string | null => {
  const simple = receiverTypeName(raw, language as LanguageName);
  if (!simple || !raw || /[.:\\]/.test(simple)) return simple;
  const escaped = simple.replace(/[$]/g, "\\$");
  const written = new RegExp(`((?:[\\w$]+(?:::|\\.|\\\\))+)${escaped}(?![\\w$])`).exec(raw);
  return written ? `${written[1]}${simple}` : simple;
};

type LanguageName = Parameters<typeof manifestFor>[0];

export function joinMemberEffects(
  analyses: readonly FileAnalysis[],
  include: (file: string) => boolean = () => true,
): { fieldWrites: FieldWriteRow[]; thrownTypes: ThrownTypeRow[]; fieldReads: FieldReadRow[] } {
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
    if (from && spansFiles(from.language)) {
      // One type of a directory: its parts across the files, never a namesake of another package, nor a type written through a package qualifier.
      const beyond = beyondDirectory(from.language);
      if (name.includes(".") && !beyond) return null;
      const dir = nearFile.slice(0, nearFile.lastIndexOf("/") + 1);
      // A qualified name states which one it means: only a lone class of its last segment answers it.
      const qualified = beyond && /[.:]/.test(name);
      const parts = qualified ? [] : (byName.get(name) ?? []).filter((c) => c.file.slice(0, c.file.lastIndexOf("/") + 1) === dir && analysisByFile.get(c.file)?.language === from.language);
      // Where a type is looked up beyond its directory, parts that only extend it (an `impl` block) do not settle which type it is.
      // ... and with real declarations of the name in several files, none of them the writer's own, nothing says which is meant.
      const named = beyond ? (byName.get(name.slice(name.search(/[^.:]*$/))) ?? []).filter((c) => analysisByFile.get(c.file)?.language === from.language) : [];
      const real = named.filter((c) => !c.cls.extension);
      // (the file's own declaration, or an `impl` block of the type it writes, makes the directory's declaration the one meant)
      if (beyond && real.length > 1 && !named.some((c) => c.file === nearFile) && new Set(real.map((c) => c.file.slice(0, c.file.lastIndexOf("/")))).size > 1) return null;
      if (parts.length > 0 && (!beyond || parts.some((c) => !c.cls.extension))) {
        const home = parts.find((c) => !c.cls.extension && c.cls.properties.length > 0) ?? parts[0]!;
        return { ...home, parts };
      }
      if (!beyond) return null;
      const found = locateIn(name, nearFile, project, line, from);
      return found && parts.length > 0 ? { ...found, parts: [found, ...parts.filter((c) => c.cls !== found.cls)] } : found;
    }
    return locateIn(name, nearFile, project, line, from);
  };

  /**
   * Does the qualifier of `name` (`java.io` in `java.io.IOException`, `Net` in `Net::ReadTimeout`) name something
   * the project declares that holds class `c`? A qualifier that is a library's package or module (`requests`, `std::io`,
   * `Foundation`) backs no project class of the same leaf, so a namesake is never the type meant. Backed when the
   * qualifier is a namespace/package `c` is declared in, a directory or file stem on `c`'s path (a Java package, a
   * Python module), a class `c`'s own file declares (a nested type, a Ruby module), or a name the writing file imports
   * from `c`'s file or namespace (`import * as errors from "./a"`, `using Err = League.Errors`). A manifest's
   * `relativeTypeQualifiers` (Rust `crate`, `self`, `super`) and a leading separator name no module: with nothing left
   * the written name is the project's own.
   */
  const qualifierBacksClass = (from: FileAnalysis, name: string, c: ClassRef): boolean => {
    const relative = new Set(manifestFor(from.language as LanguageName)?.relativeTypeQualifiers ?? []);
    const segments = name.split(/::|\\|\./).filter((x) => x.length > 0);
    segments.pop();
    while (segments.length > 0 && relative.has(segments[0]!)) segments.shift();
    if (segments.length === 0) return true;
    const norm = (x: string): string => x.toLowerCase().replace(/[_-]/g, "");
    const want = segments.map(norm);
    const qualifier = segments.join(".").toLowerCase();
    const home = analysisByFile.get(c.file);
    const spaces = [c.cls.namespace, home?.packageName, home?.declaredNamespace].filter((x): x is string => !!x).map((x) => x.replace(/::|\\/g, ".").toLowerCase());
    if (spaces.some((ns) => ns === qualifier || ns.endsWith(`.${qualifier}`))) return true;
    const path = c.file.replace(/\.[^./]+$/, "").split("/").map(norm);
    const at = (hay: string[], needle: string[]): boolean => needle.length > 0 && hay.some((_, i) => needle.every((n, k) => hay[i + k] === n));
    if (at(path, want)) return true;
    if (segments.length === 1 && home?.classes.some((k) => k !== c.cls && k.name === segments[0])) return true;
    // A name the writing file binds by an import: its source is the file (or the namespace) holding `c`.
    const bound = from.imports.filter((i) => i.specifiers.includes(segments[0]!) || Object.keys(i.aliases ?? {}).includes(segments[0]!));
    return bound.some((i) => {
      const source = i.source.replace(/^package:[^/]*\//, "").replace(/\.[^./]+$/, (m) => (/^\.(?:dart|py|js|ts|mjs|cjs|jsx|tsx|rb|php|swift|rs)$/.test(m) ? "" : m));
      const ns = source.replace(/::|\\/g, ".").toLowerCase();
      if (spaces.some((x) => x === ns)) return true;
      const parts = source.split(/[/.]|::|\\/).filter((x) => x.length > 0 && x !== "..").map(norm);
      return at(path, parts);
    });
  };

  const locateIn = (name: string, nearFile: string, project: string, line: number, from: FileAnalysis | undefined): ClassRef | null => {
    const sep = from ? manifestFor(from.language as LanguageName)?.classNamesByEvidence?.separator : undefined;
    // Only the writer's language family: a TypeScript `Error` is never a Go struct of that name.
    const family = from ? familyOf(from.language) : null;
    const inFamily = (list: ClassRef[] | undefined): ClassRef[] | undefined => {
      const kept = family === null ? list : list?.filter((c) => familyOf(analysisByFile.get(c.file)?.language ?? "") === family);
      return kept && kept.length > 0 ? kept : undefined;
    };
    // A language naming its types whole (`wholeTypeNames`) never falls back to the last segment.
    const whole = from ? manifestFor(from.language as LanguageName)?.wholeTypeNames === true : false;
    let all = inFamily(byName.get(sep ? leaf(name, sep) : name));
    // The last segment of a qualified name answers only through a qualifier the project backs (`qualifierBacksClass`).
    if (!all && !whole) {
      const byLeaf = inFamily(byName.get(leaf(name)));
      all = sep || !from || !/[.:]/.test(name) ? byLeaf : byLeaf?.filter((c) => qualifierBacksClass(from, name, c));
      if (all?.length === 0) return null;
    }
    if (all && from && beyondDirectory(from.language)) all = all.filter((c) => !c.cls.extension && analysisByFile.get(c.file)?.language === from.language);
    if (!all || all.length === 0) return null;
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

  /** The class in `ref`'s own, base or embedded chain that declares property `member` (itself when it does). */
  const declaring = (ref: ClassRef): ((member: string) => { ref: ClassRef; type?: string; typePath?: string } | null) => (member) => {
    const seen = new Set<ClassInfo>();
    const queue: ClassRef[] = [ref];
    for (let hop = 0; queue.length > 0 && hop < MAX_HOPS * 4; hop++) {
      const at = queue.shift()!;
      if (seen.has(at.cls)) continue;
      seen.add(at.cls);
      for (const part of at.parts ?? [at]) {
        const prop = part.cls.properties?.find((p) => p.name === member);
        if (prop) return { ref: part, ...(prop.type ? { type: prop.type } : {}), ...(prop.typePath ? { typePath: prop.typePath } : {}) };
        if (initMembers(part.cls).has(member)) return { ref: part };
      }
      for (const part of at.parts ?? [at]) {
        const bases = [...(part.cls.extends ? [part.cls.extends] : []), ...(spansFiles(analysisByFile.get(part.file)?.language ?? "") ? part.cls.embeds ?? [] : [])];
        for (const base of bases) {
          const next = locate(base, part.file, part.project, part.cls.line);
          if (next) queue.push(next);
        }
      }
    }
    return null;
  };

  const analysesByDir = new Map<string, FileAnalysis[]>();
  for (const a of analyses) {
    if (!include(a.filePath) || !a.packageVariables) continue;
    const dir = a.filePath.slice(0, a.filePath.lastIndexOf("/") + 1);
    analysesByDir.set(dir, [...(analysesByDir.get(dir) ?? []), a]);
  }
  const fieldWrites: FieldWriteRow[] = [];
  const thrownTypes: ThrownTypeRow[] = [];
  const fieldReads: FieldReadRow[] = [];

  const dirOf = (file: string): string => file.slice(0, file.lastIndexOf("/") + 1);
  /** The unit a package variable belongs to: the directory's package where a directory shares its names (Go), else the file's module (its stem, or the folder of a `mod`/`index` file). */
  const packageName = (file: string): string => {
    const dirName = dirOf(file).split("/").filter(Boolean).pop() ?? "main";
    if (manifestFor(analysisByFile.get(file)?.language as LanguageName)?.directoryNamesShared === true) return dirName;
    const stem = file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    return /^(?:mod|index|lib|main|__init__)$/.test(stem) ? dirName : stem;
  };
  /** The one file that declares package variable `name` for a function of `a`: where the language shares a directory's names (`directoryNamesShared`) a sibling's, else its own. */
  const packageVariableHome = (a: FileAnalysis, name: string): string | null => {
    const shared = manifestFor(a.language as LanguageName)?.directoryNamesShared === true;
    const dir = dirOf(a.filePath);
    const homes = (shared ? (analysesByDir.get(dir) ?? []) : [a]).filter((x) => x.language === a.language && x.packageVariables?.some((v) => v.name === name));
    return homes.length === 1 ? homes[0]!.filePath : null;
  };

  /** The file a package variable written through its module path (`FieldWrite.receiver` on a `package` write) lives in: the language's own import resolver reads the path, and the file must declare the variable. */
  let resolveCtx: ReturnType<typeof importResolveContext> | null = null;
  const moduleVariableHome = (a: FileAnalysis, path: string, name: string): string | null => {
    const resolve = manifestFor(a.language as LanguageName)?.resolveImport;
    if (!resolve) return null;
    resolveCtx ??= importResolveContext(analyses, new Set(analysisByFile.keys()));
    const file = resolve(a.filePath, path, name, resolveCtx);
    return file && include(file) && analysisByFile.get(file)?.packageVariables?.some((v) => v.name === name) ? file : null;
  };

  const visit = (a: FileAnalysis, fn: FunctionInfo, symbol: string, owner: ClassRef | null, self: ClassRef | null = null): void => {
    const project = a.projectId ?? "";
    const typeOfName = (name: string): string | null => {
      const param = fn.params.find((p) => p.name === name);
      if (param) return pathOr(param.type, param.typePath, a.language);
      const locals = (fn.localTypes ?? []).filter((l) => l.name === name);
      if (locals.length === 0 || locals.some((l) => !l.type || l.choice !== undefined || l.soft)) return null;
      const types = new Set(locals.map((l) => writtenTypeName(l.type, a.language)));
      const only = [...types];
      return only.length === 1 ? only[0] ?? null : null;
    };
    const spans = spansFiles(a.language);
    for (const w of fn.fieldWrites ?? []) {
      if (w.init) continue;
      if (w.package) {
        const home = w.receiver ? moduleVariableHome(a, w.receiver, w.member) : packageVariableHome(a, w.member);
        if (home) fieldWrites.push({ class: packageName(home), classFile: home, member: w.member, function: symbol, file: a.filePath, line: w.line, via: "package" });
        continue;
      }
      let target: ClassRef | null = null;
      let via: FieldWriteRow["via"] = "typed";
      if (w.receiver === "this" && owner) {
        via = "this";
        // The writing class itself first: a namesake declared in the same directory (a second `Club` of another module) never answers for it.
        target = (self ? declaring(self)(w.member)?.ref : null) ?? declaring(owner)(w.member)?.ref ?? (spans ? null : owner);
      } else if (w.class) {
        // A static member written from outside: the class as written, bound through the writer's own evidence.
        const typed = locate(w.class, a.filePath, project, w.line);
        target = typed ? declaring(typed)(w.member)?.ref ?? null : null;
      } else if (w.receiver === "" && owner) {
        via = "this";
        target = declaring(owner)(w.member)?.ref ?? null;
      } else if (w.receiver.startsWith("this.") && owner) {
        const field = declaring(owner)(w.receiver.slice(5));
        const type = field?.type ? pathOr(field.type, field.typePath, a.language) : null;
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
    for (const r of fn.fieldReads ?? []) {
      // A read names a property its class DECLARES (an own or inherited one): never the owner by default, a method or an undeclared name.
      let target: ClassRef | null = null;
      let via: FieldReadRow["via"] = "typed";
      if (r.receiver === "this" && owner) {
        via = "this";
        target = (self ? declaring(self)(r.member)?.ref : null) ?? declaring(owner)(r.member)?.ref ?? null;
      } else if (r.receiver.startsWith("this.") && owner) {
        const field = declaring(owner)(r.receiver.slice(5));
        const type = field?.type ? pathOr(field.type, field.typePath, a.language) : null;
        const typed = type ? locate(type, field!.ref.file, field!.ref.project, field!.ref.cls.line) : null;
        target = typed ? declaring(typed)(r.member)?.ref ?? null : null;
      } else if (r.receiver && !r.receiver.includes(".") && r.receiver !== "this") {
        const type = typeOfName(r.receiver);
        const typed = type ? locate(type, a.filePath, project, r.line) : null;
        target = typed ? declaring(typed)(r.member)?.ref ?? null : null;
      }
      if (target) fieldReads.push({ class: target.cls.name, classFile: target.file, member: r.member, function: symbol, file: a.filePath, line: r.line, via });
    }
    for (const t of fn.throws ?? []) {
      const known = locate(t.type, a.filePath, project, t.line);
      thrownTypes.push({ type: t.type, function: symbol, file: a.filePath, line: t.line, ...(t.declared ? { declared: true as const } : {}), ...(known ? { classFile: known.file } : {}) });
    }
  };

  for (const a of analyses) {
    if (!include(a.filePath)) continue;
    for (const cls of a.classes) {
      const own: ClassRef = { cls, file: a.filePath, project: a.projectId ?? "" };
      const owner = spansFiles(a.language) ? locate(cls.name, a.filePath, own.project) ?? own : own;
      for (const m of cls.methods) if (m.fieldWrites || m.throws || m.fieldReads) visit(a, m, `${cls.name}.${m.name}`, owner, beyondDirectory(a.language) ? own : null);
    }
    for (const fn of a.functions) if (fn.fieldWrites || fn.throws || fn.fieldReads) visit(a, fn, fn.name, null);
  }
  const order = (x: { file: string; line: number; function: string }, y: { file: string; line: number; function: string }): number =>
    x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line || (x.function < y.function ? -1 : x.function > y.function ? 1 : 0);
  fieldWrites.sort(order);
  thrownTypes.sort(order);
  fieldReads.sort(order);
  return { fieldWrites, thrownTypes, fieldReads };
}
