/**
 * Overrides and the declarations they override, read from a finished analysis: the class graph's
 * `extends` / `implements` edges for the hierarchy, each class's methods from its file's analysis,
 * and the linker's fan-out edges (`relation: "implements"` — an interface or abstract method to its
 * implementations) for what the graph alone would miss. What `clarifydoc_trace direction=overrides`
 * answers, and what a signature change judges: an override still declaring the old signature
 * no longer overrides the new one.
 */
import type { ClassGraph, ClassInfo, FileAnalysis, SymbolLink } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";

/** How far up or down a hierarchy is followed. */
const MAX_DEPTH = 12;

/** A method declared in the hierarchy of another, located. */
export interface OverrideRow {
  file: string;
  /** `Class.method`, the way call links name it. */
  symbol: string;
  line: number;
  /** Classes between the two (1 = a direct subclass or base). */
  depth: number;
  /** Declared without a body: an interface method, or an abstract one. */
  abstract?: boolean;
}

/** The classes a file declares, with their methods — all this reads of a file's analysis. */
export type ClassesOf = (file: string) => Promise<Pick<FileAnalysis, "classes"> | null>;

/** A class in the hierarchy: `${file}::${name}`, the class graph's node id. */
type ClassId = string;

/** Bases and subclasses of every project class, from the class graph's inheritance edges. */
export interface InheritanceIndex {
  parents: Map<ClassId, ClassId[]>;
  children: Map<ClassId, ClassId[]>;
}

export function inheritanceIndex(graph: ClassGraph | undefined): InheritanceIndex {
  const parents = new Map<ClassId, ClassId[]>();
  const children = new Map<ClassId, ClassId[]>();
  const nodes = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  for (const e of graph?.edges ?? []) {
    if (!e.byKind.extends && !e.byKind.implements) continue;
    const from = nodes.get(e.source);
    const to = nodes.get(e.target);
    if (!from || !to || from.isExternal || to.isExternal || from.isFile || to.isFile || e.source === e.target) continue;
    (parents.get(e.source) ?? parents.set(e.source, []).get(e.source)!).push(e.target);
    (children.get(e.target) ?? children.set(e.target, []).get(e.target)!).push(e.source);
  }
  return { parents, children };
}

const classId = (file: string, name: string): ClassId => `${file}::${name}`;
const splitId = (id: ClassId): { file: string; name: string } => {
  const at = id.lastIndexOf("::");
  return { file: id.slice(0, at), name: id.slice(at + 2) };
};

/** The method `name` a class declares, when it does. */
async function declared(classesOf: ClassesOf, id: ClassId, method: string): Promise<{ line: number; abstract: boolean } | null> {
  const { file, name } = splitId(id);
  const cls = (await classesOf(file))?.classes?.find((c: ClassInfo) => c.name === name);
  const m = cls?.methods?.find((x) => x.name === method && !x.synthetic);
  if (!m) return null;
  return { line: m.line, abstract: !!m.abstract || cls!.kind === "interface" };
}

/**
 * Every override of `Class.method` (declared in `file`) below its class: on each path down, the
 * nearest class declaring the method with a body — an abstract re-declaration is listed and passed
 * through — plus the implementations the linker fanned the method out to.
 */
export async function overridesBelow(index: InheritanceIndex, links: readonly SymbolLink[], file: string, symbol: string, classesOf: ClassesOf): Promise<OverrideRow[]> {
  const dot = symbol.lastIndexOf(".");
  if (dot <= 0) return [];
  const owner = symbol.slice(0, dot);
  const method = symbol.slice(dot + 1);
  const found = new Map<string, OverrideRow>();
  const seen = new Set([classId(file, owner)]);
  let frontier = [classId(file, owner)];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next: ClassId[] = [];
    for (const id of frontier) {
      for (const sub of index.children.get(id) ?? []) {
        if (seen.has(sub)) continue;
        seen.add(sub);
        const d = await declared(classesOf, sub, method);
        const { file: f, name } = splitId(sub);
        if (d) found.set(`${f}::${name}.${method}`, { file: f, symbol: `${name}.${method}`, line: d.line, depth, ...(d.abstract ? { abstract: true } : {}) });
        if (!d || d.abstract) next.push(sub);
      }
    }
    frontier = next;
  }
  for (const l of links) {
    if (l.relation !== "implements" || l.sourceFile !== file || l.sourceSymbol !== symbol) continue;
    const key = `${l.targetFile}::${l.targetSymbol}`;
    if (!found.has(key)) found.set(key, { file: l.targetFile, symbol: l.targetSymbol, line: l.targetLine, depth: 1 });
  }
  return sortRows([...found.values()]);
}

/**
 * The declarations `Class.method` (declared in `file`) overrides or implements, up its `extends` and
 * `implements` chains: every base and interface on the way that declares the method, nearest first,
 * plus those the linker fanned out to it from.
 */
export async function declarationsAbove(index: InheritanceIndex, links: readonly SymbolLink[], file: string, symbol: string, classesOf: ClassesOf): Promise<OverrideRow[]> {
  const dot = symbol.lastIndexOf(".");
  if (dot <= 0) return [];
  const owner = symbol.slice(0, dot);
  const method = symbol.slice(dot + 1);
  const found = new Map<string, OverrideRow>();
  const seen = new Set([classId(file, owner)]);
  let frontier = [classId(file, owner)];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next: ClassId[] = [];
    for (const id of frontier) {
      for (const base of index.parents.get(id) ?? []) {
        if (seen.has(base)) continue;
        seen.add(base);
        next.push(base);
        const d = await declared(classesOf, base, method);
        const { file: f, name } = splitId(base);
        if (d) found.set(`${f}::${name}.${method}`, { file: f, symbol: `${name}.${method}`, line: d.line, depth, ...(d.abstract ? { abstract: true } : {}) });
      }
    }
    frontier = next;
  }
  for (const l of links) {
    if (l.relation !== "implements" || l.targetFile !== file || l.targetSymbol !== symbol) continue;
    const key = `${l.sourceFile}::${l.sourceSymbol}`;
    if (!found.has(key)) found.set(key, { file: l.sourceFile, symbol: l.sourceSymbol, line: l.sourceLine, depth: 1, abstract: true });
  }
  return sortRows([...found.values()]);
}

/**
 * The subclasses of a class (down) and the bases and interfaces it extends (up), for a type with no
 * method named: what `direction=overrides` lists for `Car`.
 */
export async function relatives(index: InheritanceIndex, file: string, name: string, way: "up" | "down", classesOf: ClassesOf): Promise<OverrideRow[]> {
  const edges = way === "up" ? index.parents : index.children;
  const out: OverrideRow[] = [];
  const seen = new Set([classId(file, name)]);
  let frontier = [classId(file, name)];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next: ClassId[] = [];
    for (const id of frontier) {
      for (const other of edges.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        next.push(other);
        const { file: f, name: n } = splitId(other);
        const cls = (await classesOf(f))?.classes?.find((c) => c.name === n);
        out.push({ file: f, symbol: n, line: cls?.line ?? 0, depth, ...(cls?.kind === "interface" ? { abstract: true } : {}) });
      }
    }
    frontier = next;
  }
  return sortRows(out);
}

function sortRows(rows: OverrideRow[]): OverrideRow[] {
  return rows.sort((a, b) => a.depth - b.depth || byOrdinal(a.file, b.file) || a.line - b.line);
}

/**
 * The overrides below every method the given files declare, keyed `${file}::${Class.method}` — what
 * `signatureChanges` judges a changed method's overrides by. Only classes something extends or
 * implements, or whose methods the linker fanned out, are walked.
 */
export async function overridesOfMethods(
  graph: ClassGraph | undefined,
  links: readonly SymbolLink[],
  files: ReadonlyMap<string, Pick<FileAnalysis, "classes">>,
  classesOf: ClassesOf,
): Promise<Map<string, OverrideRow[]>> {
  const index = inheritanceIndex(graph);
  const fannedOut = new Set(links.filter((l) => l.relation === "implements").map((l) => `${l.sourceFile}::${l.sourceSymbol}`));
  const out = new Map<string, OverrideRow[]>();
  for (const [file, a] of files) {
    for (const cls of a.classes ?? []) {
      const hasBelow = index.children.has(classId(file, cls.name));
      for (const m of cls.methods ?? []) {
        const symbol = `${cls.name}.${m.name}`;
        if (!hasBelow && !fannedOut.has(`${file}::${symbol}`)) continue;
        const rows = await overridesBelow(index, links, file, symbol, classesOf);
        if (rows.length) out.set(`${file}::${symbol}`, rows);
      }
    }
  }
  return out;
}
