/**
 * Owner paths and overloads: the element id of a nested or function-local symbol carries the path of what owns it, joined
 * with `.` in every language. Two nested `Builder`s of one file are `Left.Builder` / `Left.Builder.build` and
 * `Right.Builder` / `Right.Builder.build`; a type declared inside the function `migrate` is `migrate.Row`.
 * A top-level symbol keeps its name. The label (a `ClassInfo.name`, a method's own name) keeps the spelling
 * the source writes; only the id the project passes (`symbolLinks`, `complexity`, `symbolDataAccess`) holds
 * the path.
 *
 * The path comes from the file alone, so the plugins stay as they are: a class whose lines lie inside another
 * class's or a function's lines is owned by it (innermost wins), a method takes its class's path, and a plugin
 * states an owner the lines do not show (`ClassInfo.owner`, a TypeScript `namespace`). Core reads no
 * language syntax here, and never parses an id back into a path.
 *

 * Not owned, so unchanged: a function inside a function (a closure, a local function) and a class whose
 * range equals its container's (two one-line classes cannot be told nested from side by side).
 */

import { manifestFor } from "../extractors/registry.js";
import type { ClassInfo, FileAnalysis, Language, ParamInfo, ProjectAnalysis } from "../types/analysis.js";

interface Node {
  kind: "class" | "fn";
  name: string;
  line: number;
  endLine: number;
  cls?: ClassInfo;
  /** The declared parameters, where the file states them. */
  params?: ParamInfo[];
  /** A property accessor (`FunctionInfo.accessor`, `getter`): never an overload. */
  accessor?: boolean;
  /** Memoized id symbol. */
  q?: string;
}

/** The ids of one file's classes and functions that differ from their names. Empty for a file with no nesting. */
export interface OwnerIndex {
  /** The class declared at `line` under `name`: its id symbol (`name` when it is top-level). */
  classSymbol(name: string, line: number): string;
  /** The function or method a link spells `name` that starts at `line`: its id symbol. */
  functionSymbol(name: string, line: number): string;
  /** The function whose lines contain `line`, by the name a link's source names: its id symbol. */
  functionContaining(name: string, line: number): string;
  /** The one id symbol every declaration of `name` has in the file; `undefined` when two differ (the name stands for both). */
  symbolNamed(name: string): string | undefined;
  /** Whether any symbol of the file has an id other than its name (nested, function-local or overloaded). */
  readonly nested: boolean;
  /** Overload groups of the file, and those left unsplit because two members spell the same parameter types. */
  readonly overloadGroups: number;
  readonly unsplitOverloadGroups: number;
}

const NONE: OwnerIndex = {
  classSymbol: (n) => n,
  functionSymbol: (n) => n,
  functionContaining: (n) => n,
  symbolNamed: (n) => n,
  nested: false,
  overloadGroups: 0,
  unsplitOverloadGroups: 0,
};

/** Strictly larger lines; a function on exactly its class's lines (a one-line record's accessor) is the class's member. */
const contains = (outer: Node, inner: Node): boolean =>
  outer.line <= inner.line && outer.endLine >= inner.endLine && (outer.line < inner.line || outer.endLine > inner.endLine || (outer.kind === "class" && inner.kind === "fn"));

/**
 * The index of one file. Functions are the names the links spell: the file's `complexities` rows, its functions
 * and its classes' methods as `Class.method`, generated members included (a link may end at a Lombok getter).
 */
export function ownerIndex(a: FileAnalysis, lexical = !!manifestFor(a.language as Language)?.lexicalClassRanges): OwnerIndex {
  const classes = (a.classes ?? []).filter((c) => !c.synthetic && c.line > 0 && c.endLine >= c.line);
  const overloading = !!manifestFor(a.language as Language)?.overloadedMembers;
  if (classes.length === 0 && !overloading) return NONE;
  // Lines say nesting only where a class's lines are its block (`lexicalClassRanges`); a plugin's own owner holds anywhere.
  if (!lexical && !overloading && !classes.some((c) => c.owner)) return NONE;
  const nodes: Node[] = classes.map((c) => ({ kind: "class", name: c.name, line: c.line, endLine: c.endLine, cls: c }));
  const seen = new Set<string>();
  const addFn = (name: string, line: number, endLine: number | undefined): void => {
    const key = `${name}|${line}`;
    if (!name || !(line > 0) || seen.has(key)) return;
    // A generated member states no end line: it is the line it is generated from.
    const end = typeof endLine === "number" && endLine >= line ? endLine : line;
    seen.add(key);
    nodes.push({ kind: "fn", name, line, endLine: end });
  };
  for (const c of a.complexities ?? []) addFn(c.functionName, c.line, c.endLine);
  for (const f of a.functions ?? []) addFn(f.name, f.line, f.endLine);
  for (const c of classes) for (const m of c.methods ?? []) addFn(`${c.name}.${m.name}`, m.line, m.endLine);
  if (overloading) {
    const declared = new Map<string, { params: ParamInfo[]; accessor: boolean }>();
    for (const f of a.functions ?? []) declared.set(`${f.name}|${f.line}`, { params: f.params ?? [], accessor: !!f.accessor || !!f.getter });
    for (const c of a.classes ?? []) for (const m of c.methods ?? []) declared.set(`${c.name}.${m.name}|${m.line}`, { params: m.params ?? [], accessor: !!m.accessor || !!m.getter });
    for (const n of nodes) {
      const d = n.kind === "fn" ? declared.get(`${n.name}|${n.line}`) : undefined;
      if (d) { n.params = d.params; n.accessor = d.accessor; }
    }
  }

  // The innermost container of each node, by a sweep over the nodes in source order.
  nodes.sort((x, y) => x.line - y.line || y.endLine - x.endLine || (x.kind === "class" ? -1 : 1) - (y.kind === "class" ? -1 : 1));
  const container = new Map<Node, Node>();
  const stack: Node[] = [];
  for (const n of nodes) {
    while (stack.length && !contains(stack[stack.length - 1]!, n)) stack.pop();
    if (lexical && stack.length) container.set(n, stack[stack.length - 1]!);
    stack.push(n);
  }

  /** A class's own name: one a plugin already writes through its owner (`Left::Builder` inside `Left`) keeps only its last part. */
  const leafOf = (n: Node, owner: Node | undefined): string => {
    if (owner?.kind !== "class" || !n.name.startsWith(owner.name)) return n.name;
    const rest = n.name.slice(owner.name.length).replace(/^[^\w]+/, "");
    return rest && rest !== n.name.slice(owner.name.length) ? rest : n.name;
  };

  const symbolOf = (n: Node): string => {
    if (n.q !== undefined) return n.q;
    n.q = n.name; // a cycle cannot form (containers are strictly larger), but never loop
    const owner = container.get(n);
    let q = n.name;
    if (n.kind === "class") {
      const path = owner ? symbolOf(owner) : n.cls?.owner ?? "";
      if (path) q = `${path}.${leafOf(n, owner)}`;
    } else if (owner?.kind === "class") {
      // A member of its class: a name that already starts with the class (`Builder.build`) takes the class's
      // id in its place; a bare member name (`build`) is qualified only when the class itself is nested.
      const classQ = symbolOf(owner);
      if (n.name.startsWith(`${owner.name}.`)) {
        if (classQ !== owner.name) q = `${classQ}${n.name.slice(owner.name.length)}`;
      } else if (classQ !== owner.name) q = `${classQ}.${n.name}`;
    }
    n.q = q;
    return q;
  };

  const classByKey = new Map<string, Node>();
  const fnByKey = new Map<string, Node>();
  const fnsByName = new Map<string, Node[]>();
  for (const n of nodes) {
    symbolOf(n);
    if (n.kind === "class") classByKey.set(`${n.name}|${n.line}`, n);
    else {
      fnByKey.set(`${n.name}|${n.line}`, n);
      const list = fnsByName.get(n.name);
      if (list) list.push(n);
      else fnsByName.set(n.name, [n]);
    }
  }
  // Ids of members are final only once every class and function has its owner path.
  const overloads = overloading ? spellOverloads(nodes) : { groups: 0, unsplit: 0 };
  // A member the file's functions do not list (a record's accessor, a generated constructor) is `Class.member` of the one class
  // of that name; two classes of the name leave it as written.
  const classesNamed = new Map<string, Node[]>();
  for (const n of nodes) if (n.kind === "class") (classesNamed.get(n.name) ?? classesNamed.set(n.name, []).get(n.name)!).push(n);
  const memberOfUniqueClass = (name: string): string => {
    const dot = name.indexOf(".");
    const owners = dot > 0 ? classesNamed.get(name.slice(0, dot)) : undefined;
    return owners?.length === 1 ? `${owners[0]!.q}${name.slice(dot)}` : name;
  };
  const nested = nodes.some((n) => n.q !== n.name);
  if (!nested) return NONE;
  return {
    nested,
    overloadGroups: overloads.groups,
    unsplitOverloadGroups: overloads.unsplit,
    classSymbol: (name, line) => classByKey.get(`${name}|${line}`)?.q ?? name,
    functionSymbol: (name, line) => fnByKey.get(`${name}|${line}`)?.q ?? classByKey.get(`${name}|${line}`)?.q ?? memberOfUniqueClass(name),
    symbolNamed: (name) => {
      const qs = new Set<string>();
      for (const n of nodes) if (n.name === name) qs.add(n.q!);
      return qs.size === 1 ? [...qs][0] : qs.size === 0 ? name : undefined;
    },
    functionContaining: (name, line) => {
      const hit = fnsByName.get(name)?.filter((n) => n.line <= line && line <= n.endLine);
      if (hit?.length) return hit.reduce((best, n) => (n.line > best.line ? n : best)).q!;
      const cls = classes.filter((c) => c.name === name && c.line <= line && line <= c.endLine);
      return cls.length ? classByKey.get(`${name}|${cls[0]!.line}`)?.q ?? name : name;
    },
  };
}

/**
 * A parameter list as the id writes it: each type as the source writes it, whitespace dropped, no names, an untyped
 * parameter `_` (so `Pick(_,_)` still says two); joined with `,`.
 */
export function parameterTypes(params: readonly ParamInfo[]): string {
  // Whitespace is dropped, except one space where two words would otherwise run together (`const string`, `Func(Of T,Task)`).
  const spaced = (t: string): string => t.trim().replace(/\s+/g, (run, at: number, s: string) => (/\w/.test(s[at - 1] ?? "") && /\w/.test(s[at + run.length] ?? "") ? " " : ""));
  return params.map((p) => spaced(p.type ?? "") || "_").join(",");
}

/**
 * Where a name is declared at two or more lines in one scope (the same owner-qualified symbol) and none of those is a property
 * accessor, each declaration's id carries its parameter types: `Squad.Pick(int)`. Members of a group that still spell
 * alike (`Pick(int)` twice, an overload told apart only by a Swift label) keep the plain name.
 */
function spellOverloads(nodes: Node[]): { groups: number; unsplit: number } {
  const stats = { groups: 0, unsplit: 0 };
  const groups = new Map<string, Node[]>();
  for (const n of nodes) {
    if (n.kind !== "fn" || !n.params || n.accessor) continue;
    const g = groups.get(n.q!);
    if (g) g.push(n);
    else groups.set(n.q!, [n]);
  }
  for (const [q, g] of groups) {
    if (g.length < 2) continue;
    stats.groups++;
    const spelled = g.map((n) => `${q}(${parameterTypes(n.params!)})`);
    const count = new Map<string, number>();
    for (const t of spelled) count.set(t, (count.get(t) ?? 0) + 1);
    let alike = false;
    g.forEach((n, i) => {
      if (count.get(spelled[i]!) === 1) n.q = spelled[i]!;
      else alike = true;
    });
    if (alike) stats.unsplit++;
  }
  return stats;
}

/** The name a symbol answers to without its parameter types (`Squad.Pick(int)` → `Squad.Pick`). */
export function bareSymbol(symbol: string): string {
  const open = symbol.indexOf("(");
  return open > 0 && symbol.endsWith(")") ? symbol.slice(0, open) : symbol;
}

/**
 * Whether `symbol` answers to what a person typed (`want`, lowercased): the whole id, or a trailing run of its dotted
 * path. Typing no parameter list names every overload (`squad.pick` finds `Squad.Pick(int)` and `Squad.Pick(string)`);
 * typing one (`squad.pick(int)`) names the one.
 */
export function symbolAnswersTo(symbol: string, want: string): boolean {
  const s = symbol.toLowerCase();
  const hit = (c: string): boolean => c === want || c.endsWith(`.${want}`);
  return hit(s) || (!want.includes("(") && hit(bareSymbol(s)));
}

/** What `qualifyNestedSymbols` changed, by section. */
export interface QualifyCounts {
  symbolLinks: number;
  complexity: number;
  symbolDataAccess: number;
  symbolReach: number;
  /** Overload groups spelled by parameter types, and groups left unsplit (two members spell alike). */
  overloadGroups?: number;
  unsplitOverloadGroups?: number;
}

/**
 * Give every symbol of a nested or function-local declaration its owner path, in the sections that name a
 * symbol by (file, symbol): `symbolLinks`, `complexity`, `symbolDataAccess`, `symbolReach`. Runs once, after
 * every pass that matches a symbol to a declaration by its name; a name two declarations of one file share
 * (`Builder.build` in both `Left` and `Right`) is told apart by the line the section states. A `symbolReach`
 * row states no line, so a name that stands for two declarations stays as written.
 */
export function qualifyNestedSymbols(project: ProjectAnalysis, analyses: readonly FileAnalysis[]): QualifyCounts {
  const counts: QualifyCounts = { symbolLinks: 0, complexity: 0, symbolDataAccess: 0, symbolReach: 0 };
  const indexes = new Map<string, OwnerIndex>();
  for (const a of analyses) {
    const ix = ownerIndex(a);
    if (ix.nested) indexes.set(a.filePath, ix);
    counts.overloadGroups = (counts.overloadGroups ?? 0) + ix.overloadGroups;
    counts.unsplitOverloadGroups = (counts.unsplitOverloadGroups ?? 0) + ix.unsplitOverloadGroups;
  }
  if (indexes.size === 0) return counts;

  for (const l of project.symbolLinks ?? []) {
    const target = indexes.get(l.targetFile);
    if (target) {
      const q = target.functionSymbol(l.targetSymbol, l.targetLine);
      if (q !== l.targetSymbol) { l.targetSymbol = q; counts.symbolLinks++; }
    }
    const source = indexes.get(l.sourceFile);
    if (source) {
      const q = source.functionContaining(l.sourceSymbol, l.sourceLine);
      if (q !== l.sourceSymbol) { l.sourceSymbol = q; counts.symbolLinks++; }
    }
  }
  for (const c of project.complexity ?? []) {
    const ix = indexes.get(c.filePath);
    if (!ix) continue;
    for (const f of c.functions) {
      const q = ix.functionSymbol(f.functionName, f.line);
      if (q !== f.functionName) { f.functionName = q; counts.complexity++; }
    }
  }
  for (const d of project.symbolDataAccess ?? []) {
    const ix = indexes.get(d.file);
    if (!ix) continue;
    const q = ix.functionSymbol(d.symbol, d.symbolLine);
    if (q !== d.symbol) { d.symbol = q; counts.symbolDataAccess++; }
  }
  for (const r of project.symbolReach ?? []) {
    const q = indexes.get(r.file)?.symbolNamed(r.symbol);
    if (q !== undefined && q !== r.symbol) { r.symbol = q; counts.symbolReach++; }
  }
  return counts;
}
