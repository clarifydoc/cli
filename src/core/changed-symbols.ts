import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { byOrdinal } from "./ordinal.js";
import type { Confidence, FileAnalysis, ImportInfo, ProjectAnalysis, SymbolLink } from "../types/analysis.js";
import { GIT_SAFE_CONFIG, GIT_SAFE_DIFF } from "./git-safe.js";
import { importersOf } from "./importers.js";
import { manifestFor } from "../extractors/registry.js";

/** New-side line ranges a diff changed, per project-relative file (1-based, inclusive). */
export type ChangedHunks = Map<string, Array<[number, number]>> & {
  /**
   * Lines a diff deleted outright (no line added in their place), per file, as OLD-side
   * ranges. They are charged to the function that held them in the analyzed (old) file,
   * never to a neighbour on the new side — see `symbolsInHunks`.
   */
  deleted?: Map<string, Array<[number, number]>>;
  /**
   * Ranges `symbolsInHunks` matches against the stored (old) analysis when the diff
   * was parsed for the new side: deletes/edits as their old-side lines, a pure
   * insertion as the line it follows. The Map itself stays new-side for patch coverage.
   */
  old?: Map<string, Array<[number, number]>>;
};

/**
 * Parse `git diff -U0` output into changed line ranges of the NEW side (or,
 * with `side: "old"`, of the old one — for an edit not made yet, judged
 * against the analysis of the file as it is). A pure deletion on the new
 * side (`+12,0`) has no new line to mark — git's `12` is the line BEFORE the
 * gap, which may be the previous function's last line — so it is kept apart
 * as the old-side lines removed (`deleted`); every hunk that touches old lines
 * also records those ranges on `old` for symbol matching. A pure insertion on
 * the old side marks the line it follows.
 */
export function parseUnifiedHunks(diff: string, side: "new" | "old" = "new"): ChangedHunks {
  const out: ChangedHunks = new Map();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || !file) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const start = Number(side === "old" ? m[1] : m[3]);
    const countText = side === "old" ? m[2] : m[4];
    const count = countText === undefined ? 1 : Number(countText);
    // When reading the new side, record old-side ranges for symbol matching:
    // deletes/edits as the lines they touched; a pure insertion as the line it follows.
    if (side === "new") {
      const old = (out.old ??= new Map());
      const match: [number, number] =
        oldCount > 0
          ? [oldStart, oldStart + oldCount - 1]
          : [Math.max(1, oldStart), Math.max(1, oldStart)];
      (old.get(file) ?? old.set(file, []).get(file)!).push(match);
    }
    if (count === 0 && side === "new") {
      if (oldCount > 0) {
        const deleted = (out.deleted ??= new Map());
        (deleted.get(file) ?? deleted.set(file, []).get(file)!).push([oldStart, oldStart + oldCount - 1]);
      }
      continue;
    }
    const range: [number, number] = count === 0 ? [Math.max(1, start), Math.max(1, start)] : [start, start + count - 1];
    (out.get(file) ?? out.set(file, []).get(file)!).push(range);
  }
  return out;
}

/** A function or method a diff changed, named the way call links name it (`Class.method`). */
export interface ChangedSymbol {
  file: string;
  symbol: string;
  line: number;
  endLine: number;
}

/**
 * A class or interface a diff changed outside any of its methods (a field, a required member, its
 * heritage line): the type is what the change touches, not a function.
 */
export interface ChangedClass {
  file: string;
  name: string;
  kind: "class" | "interface" | "enum";
  /** Declared for its subclasses to complete (`ClassInfo.abstract`, or an interface). */
  interfaceLike: boolean;
  line: number;
  endLine: number;
}

/**
 * What a change did to the members of a type `symbolsInHunks` reported at class level: names it added
 * and names it removed, re-typed or re-parameterized (`*`: the type itself is gone).
 */
export interface ClassChange extends ChangedClass {
  /** A property was among the added members (a new required field breaks what builds the type). */
  addedField?: boolean;
  added: string[];
  changed: string[];
}

/** What `symbolsInHunks` reads of a file: its spans, where its import block is, and whether it hands imports on. */
export type HunkSpans = Pick<FileAnalysis, "functions" | "classes"> & {
  imports?: ReadonlyArray<{ line: number }>;
  /** The names the file forwards from what it imports (a re-export, or an export named like an import): an edit to its imports can change what it offers them. */
  reexports?: string[];
  /** The file's language: whether its plugin states module-level names decides how the lines above a function are read. */
  language?: FileAnalysis["language"];
  /** The names the file binds at its top level and the lines each owns (`FileAnalysis.moduleNames`). */
  moduleNames?: ReadonlyArray<{ name: string; line: number; endLine: number }>;
};

/**
 * The functions and methods whose spans the changed lines touch — the
 * innermost one for each hunk. Lines outside every span (imports, module
 * code, a whole new file) change the file, not a symbol: they are returned
 * as `moduleLevel`, and the file-level impact covers them. When the hunks
 * carry old-side ranges (`old` / `deleted` from `parseUnifiedHunks`), those
 * are matched — never the new-side Map — so a function below a deletion is
 * not judged at a shifted new-side line that lands in the neighbour above.
 */
export function symbolsInHunks(
  analyses: ReadonlyMap<string, HunkSpans>,
  hunks: ChangedHunks,
): { symbols: ChangedSymbol[]; moduleLevel: string[]; classLevel: ChangedClass[]; moduleOnly: string[]; importOnly: string[]; forwarded: Map<string, string[]>; bound: Map<string, string[]> } {
  const bound = new Map<string, Set<string>>();
  const importOnly = new Set<string>();
  const forwarded = new Map<string, string[]>();
  const symbols = new Map<string, ChangedSymbol>();
  const moduleLevel = new Set<string>();
  // Hunks in a type's body but in none of its methods; and files with a hunk in neither a method nor a type.
  const classLevel = new Map<string, ChangedClass>();
  const moduleOnly = new Set<string>();
  // A file whose diff only deletes lines has no entry in `hunks`: its deletions still count.
  const files = new Set([...hunks.keys(), ...(hunks.deleted?.keys() ?? []), ...(hunks.old?.keys() ?? [])]);
  for (const file of files) {
    const ranges = analyzedSideRanges(hunks, file);
    const a = analyses.get(file);
    if (!a) {
      moduleLevel.add(file);
      moduleOnly.add(file);
      continue;
    }
    const typeSpans: ChangedClass[] = a.classes
      .filter((c) => c.endLine >= c.line)
      .map((c) => ({ file, name: c.name, kind: c.kind ?? "class", interfaceLike: c.kind === "interface" || !!c.abstract, line: c.line, endLine: c.endLine }));
    const spans: ChangedSymbol[] = [
      ...a.functions.filter((f) => f.name !== "<setup>" && f.endLine >= f.line).map((f) => ({ file, symbol: f.name, line: f.line, endLine: f.endLine })),
      ...a.classes.flatMap((c) => c.methods.filter((m) => m.endLine >= m.line).map((m) => ({ file, symbol: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine }))),
    ];
    for (const [s, e] of ranges) {
      const hit = spans
        .filter((sp) => sp.line <= e && sp.endLine >= s)
        .sort((x, y) => (x.endLine - x.line) - (y.endLine - y.line))[0];
      if (hit) symbols.set(`${file}::${hit.symbol}`, hit);
      else {
        // A range wholly inside the lines of module-level names changes those names: the files that import them are
        // the ones to look at. This is judged before the import block, so a constant between two imports is a constant.
        const owned = ownedNames(a.moduleNames, s, e);
        if (owned) {
          const set = bound.get(file) ?? bound.set(file, new Set()).get(file)!;
          for (const n of owned) set.add(n);
          continue;
        }
        // Edits inside the file's import block change what IT imports, not what it offers its importers —
        // unless the file declares nothing and is only a barrel of imports.
        // Only top-level imports bound the block: an import inside a function or type body would stretch it
        // over every module-level line above it (a constant edited there must keep its importers).
        const lines = (a.imports ?? []).map((i) => i.line).filter((l) => !spans.some((sp) => sp.line < l && l <= sp.endLine) && !typeSpans.some((t) => t.line < l && l <= t.endLine));
        const inImports = (a.functions.length || a.classes.length) && lines.length && s >= Math.min(...lines) && e <= Math.max(...lines);
        // Lines right above a definition — a decorator written (or being written) there, the blank line before it —
        // are that definition's: the change is to it, whoever calls it. (Inside a type they stay the type's: a member
        // added between two others is judged by the type's comparison.) Only where the language's plugin states its module-level
        // names (`statesModuleNames`, the `moduleNames` hook): there a constant above a function is a name of its own, so the line is no constant.
        const below = !(a.language && manifestFor(a.language)?.statesModuleNames) || inImports || typeSpans.some((t) => t.line <= s && e <= t.endLine) ? undefined : spans.find((sp) => sp.line === e + 1);
        if (below) {
          symbols.set(`${file}::${below.symbol}`, below);
          continue;
        }
        moduleLevel.add(file);
        if (inImports) {
          importOnly.add(file);
          if (a.reexports?.length) forwarded.set(file, a.reexports);
          continue;
        }
        const type = typeSpans.filter((sp) => sp.line <= e && sp.endLine >= s).sort((x, y) => (x.endLine - x.line) - (y.endLine - y.line))[0];
        if (type) classLevel.set(`${file}::${type.name}`, type);
        else moduleOnly.add(file);
      }
    }
  }
  return {
    symbols: [...symbols.values()].sort((x, y) => byOrdinal(x.file, y.file) || x.line - y.line),
    moduleLevel: [...moduleLevel].sort(byOrdinal),
    classLevel: [...classLevel.values()].sort((x, y) => byOrdinal(x.file, y.file) || x.line - y.line),
    moduleOnly: [...moduleOnly].sort(byOrdinal),
    importOnly: [...importOnly].sort(byOrdinal),
    forwarded,
    bound: new Map([...bound].map(([f, names]) => [f, [...names].sort(byOrdinal)])),
  };
}

/**
 * The names whose lines contain all of `s..e`, or null when a line of the range belongs to none of them (a statement
 * that binds no name, a gap the extractor did not state). Lines must be covered without a hole.
 */
function ownedNames(spans: HunkSpans["moduleNames"], s: number, e: number): string[] | null {
  if (!spans?.length) return null;
  const hit = spans.filter((n) => n.line <= e && n.endLine >= s).sort((x, y) => x.line - y.line);
  if (!hit.length) return null;
  let covered = s - 1;
  for (const n of hit) {
    if (n.line > covered + 1) return null;
    covered = Math.max(covered, n.endLine);
  }
  return covered >= e ? [...new Set(hit.map((n) => n.name))] : null;
}

const RANK: Record<Confidence, number> = { EXTRACTED: 2, INFERRED: 1, AMBIGUOUS: 0 };
const weaker = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);

/** A caller the changed symbols reach in reverse, how far, and how sure the weakest hop is. */
export interface SymbolCaller {
  file: string;
  symbol: string;
  line: number;
  depth: number;
  confidence: Confidence;
  /**
   * Where this caller stands with the change (impact only): `updated` — the
   * change edits it too; `covered` — a test calls it (`coveredBy`), or a
   * coverage report says its lines ran; `test` — it is a test itself;
   * `unverified` — neither, so nothing says it still works.
   */
  standing?: "updated" | "covered" | "test" | "unverified";
  /** The nearest test that calls it, when `standing` is `covered` by call. */
  coveredBy?: { file: string; symbol: string };
}

/**
 * Who calls the changed symbols, walking call links backwards: direct callers
 * (depth 1) and those 2–4 hops away, each with the weakest confidence along
 * its best path. A caller that is a route anchor (`route:POST /orders`) is
 * an affected route. Navigational links (interface → implementation fan-out)
 * are not calls and are not followed.
 */
export function reverseSymbolReach(
  links: readonly SymbolLink[],
  changed: readonly ChangedSymbol[],
  maxDepth = 4,
  /**
   * Whether the walk goes on from a caller it reached (`file::symbol`, never a changed symbol)
   * to that caller's own caller along `link` — false keeps a hub's many callers out.
   */
  follow?: (key: string, link: SymbolLink) => boolean,
): SymbolCaller[] {
  const callersOf = new Map<string, SymbolLink[]>();
  for (const l of links) {
    // An import's `(reference)` row names a file using a symbol, not a call.
    if (l.navigational || l.sourceSymbol.startsWith("(")) continue;
    const key = `${l.targetFile}::${l.targetSymbol}`;
    (callersOf.get(key) ?? callersOf.set(key, []).get(key)!).push(l);
  }
  const best = new Map<string, SymbolCaller>();
  let frontier: Array<{ key: string; confidence: Confidence }> = changed.map((c) => ({ key: `${c.file}::${c.symbol}`, confidence: "EXTRACTED" as Confidence }));
  const seen = new Set(frontier.map((f) => f.key));
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const { key, confidence } of frontier) {
      for (const l of callersOf.get(key) ?? []) {
        if (depth > 1 && follow && !follow(key, l)) continue;
        const callerKey = `${l.sourceFile}::${l.sourceSymbol}`;
        const conf = weaker(confidence, l.confidence ?? "INFERRED");
        const prev = best.get(callerKey);
        if (!prev || prev.depth > depth || (prev.depth === depth && RANK[conf] > RANK[prev.confidence])) {
          best.set(callerKey, { file: l.sourceFile, symbol: l.sourceSymbol, line: l.sourceLine, depth, confidence: conf });
        }
        if (!seen.has(callerKey)) {
          seen.add(callerKey);
          next.push({ key: callerKey, confidence: conf });
        }
      }
    }
    frontier = next;
  }
  return [...best.values()].sort((x, y) => x.depth - y.depth || RANK[y.confidence] - RANK[x.confidence] || byOrdinal(x.file, y.file) || x.line - y.line);
}

/** Read the per-file analyses of some files from an analysis directory (`<dir>/<file>.json`); missing ones are skipped. */
export async function loadFileAnalyses(analysisDir: string, files: readonly string[]): Promise<Map<string, HunkSpans>> {
  // (Functions keep their params: signatureChanges compares them.)
  const out = new Map<string, HunkSpans>();
  await Promise.all(files.map(async (f) => {
    try {
      const a = JSON.parse(await readFile(join(analysisDir, `${f}.json`), "utf8")) as FileAnalysis;
      const imported = new Set((a.imports ?? []).flatMap((i) => [...i.specifiers, ...Object.keys(i.aliases ?? {})]));
      const reexports = (a.exports ?? []).filter((e) => e.kind === "re-export" || imported.has(e.name)).flatMap((e) => (e.sourceName ? [e.name, e.sourceName] : [e.name]));
      out.set(f, { functions: a.functions ?? [], classes: a.classes ?? [], imports: (a.imports ?? []).map((i) => ({ line: i.line })), ...(a.language ? { language: a.language } : {}), ...(reexports.length ? { reexports } : {}), ...(a.moduleNames?.length ? { moduleNames: a.moduleNames } : {}) });
    } catch {
      // Not analyzed (new since the analysis, or not a source file).
    }
  }));
  return out;
}

/** A function whose callers a change can break: removed, moved, hidden, or its parameters or return type changed. */
export interface SignatureChange {
  file: string;
  symbol: string;
  line: number;
  /**
   * `moved`: gone from this file, and the change added the same function —
   * same name, same parameters — to exactly one other file (`movedTo`).
   */
  kind: "removed" | "moved" | "arity" | "param-type" | "visibility" | "return-type";
  /**
   * Required parameters before and after (`arity`); the parameters whose declared type changed, as
   * `name: Type` (`param-type`); the declared return types (`return-type`); `exported` and `private`
   * (`visibility` — no longer exported or public, so a caller in another file loses it).
   */
  before?: number | string;
  after?: number | string;
  /**
   * `removed`: a function the change added to the same file with the same parameters — possibly
   * the same function renamed. Callers still break; the fix is the new name.
   */
  renamedTo?: string;
  /** `moved`: the file the function now lives in. */
  movedTo?: string;
  /** Callers the analysis is sure of (EXTRACTED links). */
  callers: number;
  /**
   * Other files importing it by name (`removed`, `moved`, `visibility`): an import of a name the
   * file no longer exports breaks though nothing in the importer calls it. Absent when none does.
   */
  importers?: number;
  /**
   * Overrides of the method (below its class) the change leaves declaring the old signature
   * (`arity`, `param-type`, `return-type`): they no longer override what they meant to.
   */
  staleOverrides?: Array<{ file: string; symbol: string; line: number }>;
  /**
   * The change breaks those callers as they are written. For a move, only the
   * callers in files the change leaves alone: one it edits is taken to follow
   * the function to its new place.
   */
  breaking: boolean;
}

type Spans = Pick<FileAnalysis, "functions" | "classes">;

/**
 * "removed (possibly renamed to placeOrder)", "moved to src/orders.ts", "1 → 2 required parameters",
 * "takes id: Uuid, was id: string", "no longer exported or public", "returns Order, was Order | null".
 */
export function describeSignatureChange(c: Pick<SignatureChange, "kind" | "before" | "after" | "renamedTo" | "movedTo">): string {
  if (c.kind === "removed") return c.renamedTo ? `removed (possibly renamed to ${c.renamedTo})` : "removed";
  if (c.kind === "moved") return `moved to ${c.movedTo}`;
  if (c.kind === "param-type") return `takes ${c.after}, was ${c.before}`;
  if (c.kind === "visibility") return "no longer exported or public";
  if (c.kind === "return-type") return `returns ${c.after}, was ${c.before}`;
  return `${c.before} → ${c.after} required parameters`;
}

/**
 * What a signature change leaves broken besides its callers, for a report line: "imported by 2 files",
 * "overridden by SportsCar.start (src/sports-car.ts:4), still on the old signature". Empty when nothing.
 */
export function signatureChangeTail(c: Pick<SignatureChange, "importers" | "staleOverrides">): string {
  const parts: string[] = [];
  if (c.importers) parts.push(`imported by ${c.importers} file${c.importers === 1 ? "" : "s"}`);
  const o = c.staleOverrides ?? [];
  if (o.length) {
    const shown = o.slice(0, 3).map((x) => `${x.symbol} (${x.file}:${x.line})`).join(", ");
    parts.push(`overridden by ${shown}${o.length > 3 ? ` and ${o.length - 3} more` : ""}, still on the old signature`);
  }
  return parts.join("; ");
}

/** Every function and method of a file by the name call links use, with its parameters. */
interface Signature {
  line: number;
  required: number;
  total: number;
  variadic: boolean;
  params: string;
  /** Each parameter's name and declared type as written, `type` null when it declares none. */
  typed: Array<{ name: string; type: string | null; key: string | null }>;
  returnType: string | null;
  returnKey: string | null;
  exported?: boolean;
}

function signatures(a: Spans): Map<string, Signature> {
  const out = new Map<string, Signature>();
  const add = (name: string, fn: { line: number; params?: Array<{ name: string; type?: string | null; defaultValue: string | null }>; returnType?: string | null; isExported?: boolean }) => {
    const params = (fn.params ?? []).filter((p) => p.name !== "self" && p.name !== "this" && p.name !== "cls");
    const variadic = params.some((p) => /^\.\.\.|^\*/.test(p.name));
    out.set(name, {
      line: fn.line,
      required: params.filter((p) => p.defaultValue === null && !/^\.\.\.|^\*|\?$/.test(p.name)).length,
      total: params.length,
      variadic,
      // What a rename keeps: the parameters' names and types, in order.
      params: params.map((p) => `${p.name}:${p.type ?? ""}`).join(","),
      returnType: fn.returnType?.trim().replace(/^:\s*/, "") || null,
      returnKey: normType(fn.returnType),
      typed: params.map((p) => ({ name: p.name, type: p.type?.trim() || null, key: normType(p.type) })),
      ...(typeof fn.isExported === "boolean" ? { exported: fn.isExported } : {}),
    });
  };
  for (const f of a.functions) if (f.name !== "<setup>") add(f.name, f);
  for (const c of a.classes) for (const m of c.methods) add(`${c.name}.${m.name}`, m);
  return out;
}

/**
 * What a change does to the signatures callers depend on: the stored
 * analysis is the "before", a fresh parse of the working tree the "after".
 * A function that is gone, or whose required parameters changed, is
 * reported; it is `breaking` when a caller the analysis is sure of still
 * calls it (a removal) or calls it with a count the new signature no longer
 * accepts — the arity is judged by parameter count, since a call link does
 * not carry its arguments, so an added required parameter breaks and a
 * removed one with a default does not.
 */
export function signatureChanges(
  before: ReadonlyMap<string, Spans>,
  after: ReadonlyMap<string, Spans>,
  links: readonly SymbolLink[],
  options: {
    /** The overrides below each method of `before`, keyed `${file}::${Class.method}` (`overridesOfMethods`). */
    overrides?: ReadonlyMap<string, ReadonlyArray<{ file: string; symbol: string; line: number }>>;
    /**
     * Whether the diff edits a line (old side) of a file. A call on an edited line is rewritten by the same change,
     * so a removal or re-typing leaves it nothing to be stranded by; a function calling itself never counts.
     */
    edited?: (file: string, line: number) => boolean;
  } = {},
): SignatureChange[] {
  // Files importing each symbol by name, its own file aside.
  const importerFiles = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.sourceSymbol !== "(reference)" || l.sourceFile === l.targetFile) continue;
    const key = `${l.targetFile}::${l.targetSymbol}`;
    (importerFiles.get(key) ?? importerFiles.set(key, new Set()).get(key)!).add(l.sourceFile);
  }
  const importersOf = (file: string, symbol: string) => importerFiles.get(`${file}::${symbol}`) ?? new Set<string>();
  const importerCount = (n: number) => (n ? { importers: n } : {});
  const sureCallers = new Map<string, number>();
  // A function handed on by name (`passes`) still needs to exist and be visible, but that site
  // passes it no arguments: only invoking callers judge an arity change.
  const sureInvokers = new Map<string, number>();
  const callerFiles = new Map<string, Set<string>>();
  // Callers the change itself leaves alone: the ones it can strand.
  const openCallers = new Map<string, number>();
  for (const l of links) {
    if (l.navigational || l.sourceSymbol.startsWith("(") || l.confidence !== "EXTRACTED") continue;
    const key = `${l.targetFile}::${l.targetSymbol}`;
    const rewritten = options.edited && ((l.sourceSymbol === l.targetSymbol && l.sourceFile === l.targetFile) || options.edited(l.sourceFile, l.sourceLine));
    if (!rewritten) openCallers.set(key, (openCallers.get(key) ?? 0) + 1);
    sureCallers.set(key, (sureCallers.get(key) ?? 0) + 1);
    if (l.relation !== "passes") sureInvokers.set(key, (sureInvokers.get(key) ?? 0) + 1);
    (callerFiles.get(key) ?? callerFiles.set(key, new Set()).get(key)!).add(l.sourceFile);
  }
  const before_ = new Map([...before].map(([file, spans]) => [file, signatures(spans)]));
  const after_ = new Map([...after].map(([file, spans]) => [file, signatures(spans)]));
  // Every function the change added, by name: one gone from its file may have moved to another.
  const addedTo = new Map<string, Array<{ file: string; sig: Signature }>>();
  for (const [file, next] of after_) {
    const prev = before_.get(file);
    for (const [name, sig] of next) {
      if (prev?.has(name)) continue;
      (addedTo.get(name) ?? addedTo.set(name, []).get(name)!).push({ file, sig });
    }
  }
  const out: SignatureChange[] = [];
  for (const [file, prev] of before_) {
    const next = after_.get(file);
    if (!next) continue;
    // Functions the change added to this file: a removed one with the same parameters may be it, renamed.
    const added = [...next].filter(([name]) => !prev.has(name));
    const sameClass = (a: string, b: string) => a.slice(0, a.lastIndexOf(".") + 1) === b.slice(0, b.lastIndexOf(".") + 1);
    for (const [symbol, sig] of prev) {
      const callers = sureCallers.get(`${file}::${symbol}`) ?? 0;
      const open = openCallers.get(`${file}::${symbol}`) ?? 0;
      const cur = next.get(symbol);
      // The same function — name and parameters — added to exactly one other file: a move, not a removal.
      const moved = cur ? [] : (addedTo.get(symbol) ?? []).filter((m) => m.file !== file && m.sig.params === sig.params);
      const importers = importersOf(file, symbol);
      // Overrides the change leaves as they were: in a file it does not touch, or still declaring the old parameters.
      const stale = () => {
        const rows = (options.overrides?.get(`${file}::${symbol}`) ?? []).filter((o) => {
          const now = after.get(o.file);
          if (!now) return true;
          const theirs = signatures(now).get(o.symbol);
          return !!theirs && shape(theirs) === shape(sig);
        });
        return rows.length ? { staleOverrides: rows.map((o) => ({ file: o.file, symbol: o.symbol, line: o.line })) } : {};
      };
      if (moved.length === 1) {
        const stranded = [...(callerFiles.get(`${file}::${symbol}`) ?? []), ...importers].filter((f) => f !== file && !after.has(f));
        out.push({ file, symbol, line: sig.line, kind: "moved", movedTo: moved[0]!.file, callers, ...importerCount(importers.size), breaking: stranded.length > 0 });
      } else if (!cur) {
        // Only an unambiguous match: one added function, same class, same parameters (and some to compare).
        const twins = added.filter(([name, s2]) => sameClass(name, symbol) && s2.params === sig.params && (sig.total > 0 || s2.returnKey === sig.returnKey));
        out.push({ file, symbol, line: sig.line, kind: "removed", callers, ...importerCount(importers.size), breaking: open > 0 || importers.size > 0, ...(twins.length === 1 ? { renamedTo: twins[0]![0] } : {}) });
      } else if (cur.required !== sig.required && !cur.variadic) {
        const invokers = sureInvokers.get(`${file}::${symbol}`) ?? 0;
        const overrides = stale();
        out.push({ file, symbol, line: cur.line, kind: "arity", before: sig.required, after: cur.required, callers: invokers, ...overrides, breaking: (invokers > 0 && cur.required > sig.required) || !!overrides.staleOverrides });
      } else if (sig.exported === true && cur.exported === false) {
        // Callers in its own file keep it; the others lose it, and so does every file importing it.
        const outside = [...(callerFiles.get(`${file}::${symbol}`) ?? []), ...importers].filter((f) => f !== file);
        out.push({ file, symbol, line: cur.line, kind: "visibility", before: "exported", after: "private", callers, ...importerCount(importers.size), breaking: outside.length > 0 });
      } else if (typeChanges(sig, cur)) {
        // Same parameters by position, a declared type changed: a caller passes what the old one took.
        const { before: was, after: now } = typeChanges(sig, cur)!;
        const overrides = stale();
        out.push({ file, symbol, line: cur.line, kind: "param-type", before: was, after: now, callers, ...overrides, breaking: open > 0 || !!overrides.staleOverrides });
      } else if (sig.returnKey && cur.returnKey && sig.returnKey !== cur.returnKey) {
        // A caller that uses the result was written against the old type.
        const overrides = stale();
        out.push({ file, symbol, line: cur.line, kind: "return-type", before: sig.returnType ?? sig.returnKey, after: cur.returnType ?? cur.returnKey, callers, ...overrides, breaking: open > 0 || !!overrides.staleOverrides });
      }
    }
  }
  return out.sort((x, y) => Number(y.breaking) - Number(x.breaking) || byOrdinal(x.file, y.file) || x.line - y.line);
}

/**
 * The parameters whose declared type changed between two signatures of the same
 * arity, position by position, as `name: Type` lists; null when none did. A
 * parameter that declares no type on either side is not a change.
 */
function typeChanges(was: Signature, now: Signature): { before: string; after: string } | null {
  if (was.typed.length !== now.typed.length) return null;
  const before: string[] = [];
  const after: string[] = [];
  was.typed.forEach((p, i) => {
    const q = now.typed[i]!;
    if (!p.key || !q.key || p.key === q.key) return;
    before.push(`${p.name}: ${p.type}`);
    after.push(`${q.name}: ${q.type}`);
  });
  return before.length ? { before: before.join(", "), after: after.join(", ") } : null;
}

/** What an override shares with the method it overrides: parameter count and types, and the return type — never the names. */
function shape(sig: Signature): string {
  return `${sig.total}|${sig.typed.map((t) => t.key ?? "").join(",")}|${sig.returnKey ?? ""}`;
}

/** A declared type compared as written, whitespace aside. */
function normType(t: string | null | undefined): string | null {
  const s = (t ?? "").replace(/\s+/g, "").replace(/^:/, "");
  return s ? s : null;
}

/**
 * `signatureChanges` with the overrides of each changed method found first — from the class graph
 * and the per-file analyses in `analysisDir` (those of `before` as they are) — so an override the
 * change leaves on the old signature is judged with the callers.
 */
export async function judgeSignatures(
  analysisDir: string,
  before: ReadonlyMap<string, Spans>,
  after: ReadonlyMap<string, Spans>,
  summary: Pick<ProjectAnalysis, "symbolLinks" | "classGraph">,
  edited?: (file: string, line: number) => boolean,
): Promise<SignatureChange[]> {
  const { overridesOfMethods } = await import("./overrides.js");
  const links = summary.symbolLinks ?? [];
  const loaded = new Map<string, Spans | null>();
  const classesOf = async (f: string) => {
    if (before.has(f)) return before.get(f)!;
    if (!loaded.has(f)) loaded.set(f, (await loadFileAnalyses(analysisDir, [f])).get(f) ?? null);
    return loaded.get(f) ?? null;
  };
  const overrides = await overridesOfMethods(summary.classGraph, links, before, classesOf);
  return signatureChanges(before, after, links, { overrides, ...(edited ? { edited } : {}) });
}

/**
 * What the change did to each type it touched at class level, by comparing the type before and after:
 * the member names it added, and those it removed or re-typed. A type the edit could not be read
 * again for reads as wholly changed (`*`), so nothing narrows on a guess.
 */
export function classChanges(before: ReadonlyMap<string, Spans>, after: ReadonlyMap<string, Spans>, touched: readonly ChangedClass[]): ClassChange[] {
  const members = (c: Spans["classes"][number]): Map<string, string> => {
    const m = new Map<string, string>();
    for (const p of c.properties ?? []) m.set(p.name, `p:${p.type ?? ""}:${p.visibility ?? ""}`);
    for (const f of c.methods ?? []) m.set(f.name, `m:${f.params?.length ?? 0}:${f.returnType ?? ""}`);
    return m;
  };
  return touched.map((t) => {
    const was = before.get(t.file)?.classes.find((c) => c.name === t.name);
    const now = after.get(t.file)?.classes.find((c) => c.name === t.name);
    if (!was || !now) return { ...t, added: [], changed: ["*"] };
    const a = members(was);
    const b = members(now);
    const added = [...b.keys()].filter((k) => !a.has(k));
    const changed = [...a].filter(([k, v]) => b.get(k) !== v).map(([k]) => k);
    if ((was.extends ?? "") !== (now.extends ?? "") || [...(was.implements ?? [])].sort().join() !== [...(now.implements ?? [])].sort().join()) changed.push("<heritage>");
    return { ...t, added, changed, ...(added.some((k) => b.get(k)?.startsWith("p:")) ? { addedField: true } : {}) };
  });
}

/**
 * A file's changed ranges on the side the stored analysis describes: the old-side ranges when the parser
 * recorded them, else the Map as written (new-side, or a hand-built range list) for pure insertions and older callers.
 */
function analyzedSideRanges(hunks: ChangedHunks, file: string): Array<[number, number]> {
  const oldSide = [...(hunks.old?.get(file) ?? []), ...(hunks.deleted?.get(file) ?? [])];
  return oldSide.length > 0 ? oldSide : [...(hunks.get(file) ?? [])];
}

/** Whether the diff edits a line of a file, on the side the stored analysis describes. */
export function editedLines(hunks: ChangedHunks): (file: string, line: number) => boolean {
  const byFile = new Map<string, Array<[number, number]>>();
  return (file, line) => {
    const ranges = byFile.get(file) ?? byFile.set(file, analyzedSideRanges(hunks, file)).get(file)!;
    return ranges.some(([a, b]) => a <= line && line <= b);
  };
}

/**
 * The change at the level of functions and types, for `computeImpactDiff`'s `symbols`: what the diff's lines
 * touched in `files` (as the analysis in `analysisDir` has them), the signatures that changed and the
 * members a type gained or lost. `contents` is an edit not made yet; without it the working tree is read.
 */
export async function symbolsOfChange(
  root: string,
  analysisDir: string,
  summary: Pick<ProjectAnalysis, "symbolLinks" | "classGraph" | "componentGraph" | "starReexports">,
  files: readonly string[],
  hunks: ChangedHunks,
  contents?: ReadonlyMap<string, string | null>,
) {
  const before = await loadFileAnalyses(analysisDir, files);
  const found = symbolsInHunks(before, hunks);
  // Every touched file, new ones too: a function that left one file may have moved into another.
  const after = await analyzeWorkingFiles(root, files, contents);
  const read = analysisReader(analysisDir);
  return {
    changed: found.symbols,
    moduleLevel: found.moduleLevel,
    moduleOnly: found.moduleOnly,
    importOnly: found.importOnly,
    forwarded: Object.fromEntries(found.forwarded),
    boundReaders: await boundReaders(analysisDir, summary, found.bound, read),
    starForwarders: await starForwarders(analysisDir, summary, files, read),
    signatureChanges: await judgeSignatures(analysisDir, before, after, summary, editedLines(hunks)),
    classChanges: classChanges(before, after, found.classLevel),
    hunks,
  };
}

/** The words a module path or import source is written with, split at dots and slashes (`pkg.settings`, `./settings.js` → `pkg`, `settings`, `js`). */
const pathWords = (path: string): string[] => path.split(/[./\\]+/).filter(Boolean);

/**
 * Whether a file's imports can read one of `names` from the module at `target`: a row that lists a name, a star
 * import, or a row that takes the whole module (a namespace, a default, a bare `import m`, `from p import module`)
 * and spells its name. Which row reaches `target` is not resolved, so any row naming the name counts — never fewer
 * files than the ones that import it. A file with no row that even spells the module's name (an edge no import states)
 * is kept: nothing says it does not read the name.
 */
function mayRead(imports: readonly ImportInfo[], target: string, names: ReadonlySet<string>): boolean {
  const stem = pathWords(target.split("/").pop() ?? target)[0] ?? "";
  let relates = false;
  for (const i of imports) {
    if (i.executes) continue;
    const listed = [...i.specifiers, ...Object.values(i.aliases ?? {})];
    if (listed.some((n) => names.has(n)) || i.specifiers.includes("*")) return true;
    const spelled = i.specifiers.includes(stem) || pathWords(i.source).includes(stem);
    if (!spelled) continue;
    relates = true;
    if (i.isNamespace || i.isDefault || i.specifiers.length === 0 || i.specifiers.includes(stem)) return true;
  }
  return !relates;
}

/**
 * For files whose edit changed module-level names (`bound`: file → names), the files that read them: importers whose
 * imports name one, or take the module whole — and, through an importer that forwards the name (a re-export), the
 * importers of that file in turn. An importer the analysis has no record of stays. Importers come from
 * `componentGraph` (every importing file, whatever the length of `affectedFiles`).
 */
/** A reader of the per-file analyses under `analysisDir`, each read once (null when it is missing or unreadable). */
export function analysisReader(analysisDir: string): (file: string) => Promise<FileAnalysis | null> {
  const loaded = new Map<string, Promise<FileAnalysis | null>>();
  return (f) => {
    let p = loaded.get(f);
    if (!p) {
      p = readFile(join(analysisDir, `${f}.json`), "utf8").then((t) => JSON.parse(t) as FileAnalysis, () => null);
      loaded.set(f, p);
    }
    return p;
  };
}

export async function boundReaders(
  analysisDir: string,
  summary: Pick<ProjectAnalysis, "componentGraph">,
  bound: ReadonlyMap<string, readonly string[]>,
  analysisOf = analysisReader(analysisDir),
): Promise<Record<string, string[]>> {
  if (!bound.size) return {};
  const importers = importersOf(summary.componentGraph);
  const out: Record<string, string[]> = {};
  for (const [file, names] of bound) {
    const readers = new Set<string>();
    const seen = new Set<string>([file]);
    let frontier: Array<{ file: string; names: ReadonlySet<string> }> = [{ file, names: new Set(names) }];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: typeof frontier = [];
      for (const hop of frontier) {
        for (const importer of importers.get(hop.file) ?? []) {
          if (seen.has(importer)) continue;
          const a = await analysisOf(importer);
          if (a && !mayRead(a.imports ?? [], hop.file, hop.names)) continue;
          seen.add(importer);
          readers.add(importer);
          // A file that hands the names on — a re-export or export of one, a star re-export — offers them to its own importers (under the name it gives them).
          const handed = new Set<string>();
          for (const e of a?.exports ?? []) {
            if (e.name === "*") for (const n of hop.names) handed.add(n);
            else if (hop.names.has(e.name) || (e.sourceName && hop.names.has(e.sourceName))) handed.add(e.name), e.sourceName && handed.add(e.sourceName);
          }
          if (!a) for (const n of hop.names) handed.add(n);
          if (handed.size) next.push({ file: importer, names: handed });
        }
      }
      frontier = next;
    }
    out[file] = [...readers].sort(byOrdinal);
  }
  return out;
}

/**
 * The files that hand a module's names on whole — Python `from .hooks import *` in a package file, JS/TS
 * `export * from "./hooks"` / `export * as ns from` — among the files that (transitively) import `files`, each
 * with the files it forwards. A forwarder names no member, so no call or import-by-name link reaches the module
 * through it; what the module loses, it loses too. Importers come from `componentGraph`; the module a star
 * export names is the file the analysis resolved it to (`starReexports`), else — an old summary, an unresolved
 * source — the importee whose path spells the source's words.
 */
export async function starForwarders(
  analysisDir: string,
  summary: Pick<ProjectAnalysis, "componentGraph" | "starReexports">,
  files: readonly string[],
  analysisOf = analysisReader(analysisDir),
): Promise<Record<string, string[]>> {
  const importers = importersOf(summary.componentGraph);
  const seen = new Set(files);
  const out: Record<string, string[]> = {};
  for (let frontier = [...files]; frontier.length; ) {
    const next: string[] = [];
    for (const f of frontier) for (const from of importers.get(f) ?? []) if (!seen.has(from)) (seen.add(from), next.push(from));
    frontier = next;
  }
  const closure = [...seen];
  const analyses: Array<FileAnalysis | null> = [];
  for (let i = 0; i < closure.length; i += 32) analyses.push(...(await Promise.all(closure.slice(i, i + 32).map(analysisOf))));
  for (let k = 0; k < closure.length; k++) {
    const f = closure[k]!;
    const a = analyses[k];
    if (!a) continue;
    const stars = (a.exports ?? []).filter((e) => e.name === "*" && e.source);
    if (!stars.length) continue;
    const targets = new Set<string>();
    for (const e of stars) {
      // Where the import index resolved this source, when the analysis recorded it.
      const resolved = summary.starReexports?.[f]?.[e.source!];
      if (resolved) {
        targets.add(resolved);
        continue;
      }
      // The importee whose path spells the source's words (`.hooks`, `./hooks.service`, `pkg.hooks`): which row reaches which file is not resolved, so a package folder over-matches rather than misses.
      const wanted = pathWords(e.source!);
      for (const t of summary.componentGraph[f] ?? []) {
        const have = new Set(pathWords(t));
        if (wanted.length && wanted.every((w) => have.has(w))) targets.add(t);
      }
    }
    if (targets.size) out[f] = [...targets].sort(byOrdinal);
  }
  return out;
}

/**
 * Parse the working-tree version of some files, in memory, the way the
 * analysis did — the "after" side of `signatureChanges`. Files the analysis
 * cannot read are skipped.
 */
export async function analyzeWorkingFiles(projectRoot: string, files: readonly string[], contents?: ReadonlyMap<string, string | null>): Promise<Map<string, Spans>> {
  const [{ analyzeFile }, { getLanguageForFile }, { isShebangScriptPlace, shebangScriptAt }, { mkdtemp, rm, mkdir, writeFile }, { tmpdir }, { existsSync }] = await Promise.all([
    import("./file-analyzer.js"),
    import("../parsers/language-map.js"),
    import("./file-discovery.js"),
    import("fs/promises"),
    import("os"),
    import("fs"),
  ]);
  const out = new Map<string, Spans>();
  const scratch = await mkdtemp(join(tmpdir(), "clarifydoc-after-"));
  try {
    for (const f of files) {
      let language = getLanguageForFile(f);
      if (!language) {
        // An extension-less script, by its `#!` line where discovery reads one: the proposed text, else the working tree.
        if (!isShebangScriptPlace(f)) continue;
        const proposed = contents?.get(f);
        const gone = contents?.has(f) ? proposed === null || proposed === undefined : !existsSync(join(projectRoot, f));
        // Deleted: whatever it held is gone (a file the analysis never read had nothing to lose).
        if (gone) {
          out.set(f, { functions: [], classes: [] });
          continue;
        }
        language = shebangScriptAt(projectRoot, f, proposed ?? undefined);
        if (!language) continue;
      }
      // Proposed content is parsed from a scratch copy; null proposes deleting the file.
      let absolutePath = join(projectRoot, f);
      if (contents?.has(f)) {
        const text = contents.get(f);
        if (text === null || text === undefined) {
          out.set(f, { functions: [], classes: [] });
          continue;
        }
        absolutePath = join(scratch, "proposed", f);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, text);
      }
      // A file the change deleted: every function it had is gone (and there is nothing to parse).
      if (!contents?.has(f) && !existsSync(absolutePath)) {
        out.set(f, { functions: [], classes: [] });
        continue;
      }
      const res = await analyzeFile({
        file: { absolutePath, relativePath: f, language },
        frameworkIds: [],
        projectId: "root",
        outputOpts: { outputDir: scratch, pretty: false },
        verbose: false,
        projectRoot,
        tsconfigAliases: new Map(),
      }).catch(() => null);
      if (res) out.set(f, { functions: res.analysis.functions, classes: res.analysis.classes });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return out;
}

/**
 * The lines an edit not made yet would change, in the coordinates of the
 * file as it is now — what the stored analysis describes. From
 * `git diff --no-index -U0` when git is there; else the span between the
 * common prefix and suffix (one region: an over-approximation for several
 * separate edits, never an under-one). A missing current file is all new.
 */
export async function proposedHunks(projectRoot: string, proposals: ReadonlyMap<string, string | null>): Promise<ChangedHunks> {
  const [{ execFile }, { mkdtemp, rm, writeFile: write }, { tmpdir }, { existsSync }] = await Promise.all([
    import("child_process"),
    import("fs/promises"),
    import("os"),
    import("fs"),
  ]);
  const out: ChangedHunks = new Map();
  const scratch = await mkdtemp(join(tmpdir(), "clarifydoc-edit-"));
  try {
    for (const [file, next] of proposals) {
      const path = join(projectRoot, file);
      const before = existsSync(path) ? await readFile(path, "utf-8") : null;
      if (before === null) continue;
      const lines = before.split("\n").length;
      if (next === null) {
        out.set(file, [[1, lines]]);
        continue;
      }
      if (next === before) continue;
      const a = join(scratch, "a");
      const b = join(scratch, "b");
      await write(a, before);
      await write(b, next);
      const diff = await new Promise<string | null>((res) =>
        execFile("git", [...GIT_SAFE_CONFIG, "diff", "--no-index", "-U0", "--no-color", ...GIT_SAFE_DIFF, a, b], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
          // Exit 1 means "they differ" — the answer, not a failure.
          res(err && (err as { code?: number }).code !== 1 ? null : stdout),
        ),
      );
      const ranges = diff !== null ? [...parseUnifiedHunks(diff.replace(/^\+\+\+ .*$/m, `+++ b/${file}`), "old").get(file) ?? []] : null;
      if (ranges && ranges.length) {
        out.set(file, ranges);
        continue;
      }
      const x = before.split("\n");
      const y = next.split("\n");
      let p = 0;
      while (p < x.length && p < y.length && x[p] === y[p]) p++;
      let q = 0;
      while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
      const start = Math.min(p + 1, lines);
      out.set(file, [[start, Math.max(start, x.length - q)]]);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return out;
}
