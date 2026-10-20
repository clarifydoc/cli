import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { byOrdinal } from "./ordinal.js";
import type { Confidence, FileAnalysis, SymbolLink } from "../types/analysis.js";
import { GIT_SAFE_CONFIG, GIT_SAFE_DIFF } from "./git-safe.js";

/** New-side line ranges a diff changed, per project-relative file (1-based, inclusive). */
export type ChangedHunks = Map<string, Array<[number, number]>>;

/**
 * Parse `git diff -U0` output into changed line ranges of the NEW side (or,
 * with `side: "old"`, of the old one — for an edit not made yet, judged
 * against the analysis of the file as it is). A pure deletion (`+12,0`)
 * marks the line it was deleted before, so the function it sat in still
 * counts as changed; a pure insertion on the old side marks the line it
 * follows.
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
    const start = Number(side === "old" ? m[1] : m[3]);
    const countText = side === "old" ? m[2] : m[4];
    const count = countText === undefined ? 1 : Number(countText);
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
 * The functions and methods whose spans the changed lines touch — the
 * innermost one for each hunk. Lines outside every span (imports, module
 * code, a whole new file) change the file, not a symbol: they are returned
 * as `moduleLevel`, and the file-level impact covers them.
 */
export function symbolsInHunks(
  analyses: ReadonlyMap<string, Pick<FileAnalysis, "functions" | "classes">>,
  hunks: ChangedHunks,
): { symbols: ChangedSymbol[]; moduleLevel: string[] } {
  const symbols = new Map<string, ChangedSymbol>();
  const moduleLevel = new Set<string>();
  for (const [file, ranges] of hunks) {
    const a = analyses.get(file);
    if (!a) {
      moduleLevel.add(file);
      continue;
    }
    const spans: ChangedSymbol[] = [
      ...a.functions.filter((f) => f.name !== "<setup>" && f.endLine >= f.line).map((f) => ({ file, symbol: f.name, line: f.line, endLine: f.endLine })),
      ...a.classes.flatMap((c) => c.methods.filter((m) => m.endLine >= m.line).map((m) => ({ file, symbol: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine }))),
    ];
    for (const [s, e] of ranges) {
      const hit = spans
        .filter((sp) => sp.line <= e && sp.endLine >= s)
        .sort((x, y) => (x.endLine - x.line) - (y.endLine - y.line))[0];
      if (hit) symbols.set(`${file}::${hit.symbol}`, hit);
      else moduleLevel.add(file);
    }
  }
  return {
    symbols: [...symbols.values()].sort((x, y) => byOrdinal(x.file, y.file) || x.line - y.line),
    moduleLevel: [...moduleLevel].sort(byOrdinal),
  };
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
}

/**
 * Who calls the changed symbols, walking call links backwards: direct callers
 * (depth 1) and those 2–4 hops away, each with the weakest confidence along
 * its best path. A caller that is a route anchor (`route:POST /orders`) is
 * an affected route. Navigational links (interface → implementation fan-out)
 * are not calls and are not followed.
 */
export function reverseSymbolReach(links: readonly SymbolLink[], changed: readonly ChangedSymbol[], maxDepth = 4): SymbolCaller[] {
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
export async function loadFileAnalyses(analysisDir: string, files: readonly string[]): Promise<Map<string, Pick<FileAnalysis, "functions" | "classes">>> {
  // (Functions keep their params: signatureChanges compares them.)
  const out = new Map<string, Pick<FileAnalysis, "functions" | "classes">>();
  await Promise.all(files.map(async (f) => {
    try {
      const a = JSON.parse(await readFile(join(analysisDir, `${f}.json`), "utf8")) as FileAnalysis;
      out.set(f, { functions: a.functions ?? [], classes: a.classes ?? [] });
    } catch {
      // Not analyzed (new since the analysis, or not a source file).
    }
  }));
  return out;
}

/** A function whose callers a change can break: removed, or its required parameters changed. */
export interface SignatureChange {
  file: string;
  symbol: string;
  line: number;
  kind: "removed" | "arity";
  /** Required parameters before and after (`arity`). */
  before?: number;
  after?: number;
  /** Callers the analysis is sure of (EXTRACTED links). */
  callers: number;
  /** The change breaks those callers as they are written. */
  breaking: boolean;
}

type Spans = Pick<FileAnalysis, "functions" | "classes">;

/** Every function and method of a file by the name call links use, with its parameters. */
function signatures(a: Spans): Map<string, { line: number; required: number; total: number; variadic: boolean }> {
  const out = new Map<string, { line: number; required: number; total: number; variadic: boolean }>();
  const add = (name: string, fn: { line: number; params?: Array<{ name: string; defaultValue: string | null }> }) => {
    const params = (fn.params ?? []).filter((p) => p.name !== "self" && p.name !== "this" && p.name !== "cls");
    const variadic = params.some((p) => /^\.\.\.|^\*/.test(p.name));
    out.set(name, { line: fn.line, required: params.filter((p) => p.defaultValue === null && !/^\.\.\.|^\*|\?$/.test(p.name)).length, total: params.length, variadic });
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
): SignatureChange[] {
  const sureCallers = new Map<string, number>();
  for (const l of links) {
    if (l.navigational || l.sourceSymbol.startsWith("(") || l.confidence !== "EXTRACTED") continue;
    const key = `${l.targetFile}::${l.targetSymbol}`;
    sureCallers.set(key, (sureCallers.get(key) ?? 0) + 1);
  }
  const out: SignatureChange[] = [];
  for (const [file, was] of before) {
    const now = after.get(file);
    if (!now) continue;
    const prev = signatures(was);
    const next = signatures(now);
    for (const [symbol, sig] of prev) {
      const callers = sureCallers.get(`${file}::${symbol}`) ?? 0;
      const cur = next.get(symbol);
      if (!cur) {
        out.push({ file, symbol, line: sig.line, kind: "removed", callers, breaking: callers > 0 });
      } else if (cur.required !== sig.required && !cur.variadic) {
        out.push({ file, symbol, line: cur.line, kind: "arity", before: sig.required, after: cur.required, callers, breaking: callers > 0 && cur.required > sig.required });
      }
    }
  }
  return out.sort((x, y) => Number(y.breaking) - Number(x.breaking) || byOrdinal(x.file, y.file) || x.line - y.line);
}

/**
 * Parse the working-tree version of some files, in memory, the way the
 * analysis did — the "after" side of `signatureChanges`. Files the analysis
 * cannot read are skipped.
 */
export async function analyzeWorkingFiles(projectRoot: string, files: readonly string[], contents?: ReadonlyMap<string, string | null>): Promise<Map<string, Spans>> {
  const [{ analyzeFile }, { getLanguageForFile }, { mkdtemp, rm, mkdir, writeFile }, { tmpdir }] = await Promise.all([
    import("./file-analyzer.js"),
    import("../parsers/language-map.js"),
    import("fs/promises"),
    import("os"),
  ]);
  const out = new Map<string, Spans>();
  const scratch = await mkdtemp(join(tmpdir(), "clarifydoc-after-"));
  try {
    for (const f of files) {
      const language = getLanguageForFile(f);
      if (!language) continue;
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
      // A file the change deleted: every function it had is gone.
      else if (!(await import("fs")).existsSync(join(projectRoot, f))) out.set(f, { functions: [], classes: [] });
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
