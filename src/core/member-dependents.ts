import type { BlastRadiusInfo, ProjectAnalysis, SymbolLink, TypeUsageKind } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { EXTENSION_TO_LANGUAGE, manifestFor } from "../extractors/registry.js";

/**
 * Which files NAME what a change touched — the members, not the module. A file importing a changed
 * file is only charged when it calls a changed function, or names a changed type in a way the change
 * can break; the importers that do neither are context ("imports it"), not work.
 *
 * Facts only, all from the analysis: call and import-by-name links (`symbolLinks`) and each class's
 * usage by kind (`blastRadius[].typeUsages`).
 */

/** A thing a change touched, in a file. */
export type MemberTarget =
  | { file: string; symbol: string }
  | {
      file: string;
      /** A type, judged by how files use it. */
      type: string;
      /**
       * `added`: only members were added; an interface (or abstract type) then breaks what implements, extends or
       * builds it, never what only passes it on. `changed`: a member was removed or re-typed, or the type's
       * heritage changed — everything naming the type may read it.
       */
      mode: "added" | "changed";
      /** An interface, or a type declared for its subclasses to complete. */
      interfaceLike: boolean;
      /** Members were added and one is a field: a class gaining a required field breaks what builds it, as an interface does. */
      field?: true;
    };

/** Usage kinds that make a value of the type, extend it or implement it: what a new required member breaks. */
const PRODUCER_KINDS: ReadonlySet<TypeUsageKind> = new Set<TypeUsageKind>(["implements", "extends", "instantiation", "variable", "return", "field", "cast"]);

export interface NamingFiles {
  /** File → why it is charged, strongest reason first. Never the target's own file. */
  files: Map<string, string[]>;
  /** The analysis cannot say who names a target (a type with no usage record): charge every importer. */
  undecided: boolean;
  /** Per target, in order: whether any file names it. */
  named: boolean[];
}

/** What `filesNaming` reads, built once per question: the links into the changed files by target symbol, and the blast rows by file. */
export interface NamingIndex {
  into: Map<string, SymbolLink[]>;
  blast: Map<string, BlastRadiusInfo>;
}

/** The index for questions about `files` (the files whose members changed). */
export function namingIndex(summary: Pick<ProjectAnalysis, "symbolLinks" | "blastRadius">, files: Iterable<string>): NamingIndex {
  const wanted = new Set(files);
  const into = new Map<string, SymbolLink[]>();
  for (const l of summary.symbolLinks ?? []) {
    if (!wanted.has(l.targetFile) || l.sourceFile === l.targetFile || l.navigational) continue;
    const key = `${l.targetFile}::${l.targetSymbol}`;
    (into.get(key) ?? into.set(key, []).get(key)!).push(l);
  }
  return { into, blast: new Map((summary.blastRadius ?? []).map((b) => [b.filePath, b])) };
}

/** Whether the file's language records every naming of a type, so a type with no usage record is named by nobody. */
function typeUsageComplete(file: string): boolean {
  const language = EXTENSION_TO_LANGUAGE[file.slice(file.lastIndexOf(".")).toLowerCase()];
  return language !== undefined && manifestFor(language)?.typeUsageComplete === true;
}

/** The files that name any of `targets`, with the reason for each. */
export function filesNaming(index: NamingIndex, targets: readonly MemberTarget[]): NamingFiles {
  const files = new Map<string, string[]>();
  let hit = false;
  const add = (file: string, reason: string) => {
    hit = true;
    const rows = files.get(file) ?? files.set(file, []).get(file)!;
    if (!rows.includes(reason)) rows.push(reason);
  };
  let undecided = false;
  const named: boolean[] = [];
  const { into, blast } = index;
  for (const t of targets) {
    hit = false;
    if ("symbol" in t) {
      for (const l of into.get(`${t.file}::${t.symbol}`) ?? []) add(l.sourceFile, l.sourceSymbol === "(reference)" ? `imports ${t.symbol}` : `calls ${t.symbol}`);
      named.push(hit);
      continue;
    }
    const usage = blast.get(t.file)?.typeUsages?.find((u) => u.typeName === t.type);
    if (!usage && !typeUsageComplete(t.file)) {
      undecided = true;
      named.push(false);
      continue;
    }
    // No record in a language that records every naming of a type: nobody names it by type, only the links below can.
    for (const u of usage?.usagesByFile ?? []) {
      if (u.filePath === t.file) continue;
      const kinds = Object.keys(u.byKind) as TypeUsageKind[];
      const used = t.mode === "changed" ? kinds : t.interfaceLike || t.field ? kinds.filter((k) => PRODUCER_KINDS.has(k)) : [];
      if (used.length) add(u.filePath, `${used.join("/")} ${t.type}`);
    }
    if (t.mode === "changed") for (const l of into.get(`${t.file}::${t.type}`) ?? []) add(l.sourceFile, l.sourceSymbol === "(reference)" ? `imports ${t.type}` : `constructs ${t.type}`);
    else if (t.interfaceLike || t.field) for (const l of into.get(`${t.file}::${t.type}`) ?? []) if (l.sourceSymbol !== "(reference)") add(l.sourceFile, `constructs ${t.type}`);
    named.push(hit);
  }
  return { files, undecided, named };
}

/**
 * The `importers` that import one of `names` by name — their `(reference)` rows for it, which lead to the
 * definition however many files forward it. What a file that re-exports an import offers, by name.
 */
export function filesImportingNames(summary: Pick<ProjectAnalysis, "symbolLinks">, importers: ReadonlySet<string>, names: readonly string[]): string[] {
  const wanted = new Set(names);
  const out = new Set<string>();
  for (const l of summary.symbolLinks ?? []) if (l.sourceSymbol === "(reference)" && importers.has(l.sourceFile) && wanted.has(l.targetSymbol)) out.add(l.sourceFile);
  return [...out].sort(byOrdinal);
}

/**
 * Targets from names a caller states for one file (`Class.method`, `function`, `Type`): a name the file's
 * type usages know is a type, anything else a symbol. `adding` says the names are new members.
 */
export function targetsFromNames(index: NamingIndex, file: string, names: readonly string[], adding = false): MemberTarget[] {
  const blast = index.blast.get(file);
  return names.map((n): MemberTarget => {
    const type = blast?.typeUsages?.find((u) => u.typeName === n);
    return type ? { file, type: n, mode: adding ? "added" : "changed", interfaceLike: type.definedAt.isInterface } : { file, symbol: n };
  });
}

/**
 * Importers of a file ranked by how much of it they use — files calling or referencing its exports
 * first, the most used first; files that only import it last.
 */
export function rankByUse(blast: Pick<BlastRadiusInfo, "exportedSymbols">, files: readonly string[]): string[] {
  const uses = new Map<string, number>();
  for (const s of blast.exportedSymbols) for (const c of s.callers) uses.set(c.file, (uses.get(c.file) ?? 0) + 1);
  return [...files].sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0) || byOrdinal(a, b));
}
