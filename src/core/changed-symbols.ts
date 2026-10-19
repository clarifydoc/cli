import { readFile } from "fs/promises";
import { join } from "path";
import { byOrdinal } from "./ordinal.js";
import type { Confidence, FileAnalysis, SymbolLink } from "../types/analysis.js";

/** New-side line ranges a diff changed, per project-relative file (1-based, inclusive). */
export type ChangedHunks = Map<string, Array<[number, number]>>;

/**
 * Parse `git diff -U0` output into changed line ranges of the NEW side. A pure
 * deletion (`+12,0`) marks the line it was deleted before, so the function it
 * sat in still counts as changed.
 */
export function parseUnifiedHunks(diff: string): ChangedHunks {
  const out: ChangedHunks = new Map();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || !file) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
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
