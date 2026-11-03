/**
 * The test functions the extractors marked (`FunctionInfo.testCase`), gathered
 * per file into `ProjectAnalysis.testFunctions`, and the one place readers ask
 * whether a caller is test code: a test file by path, or a test declared beside
 * production code (a Rust `#[cfg(test)]` module, a Zig `test` block).
 */

import type { FileAnalysis, ProjectAnalysis, SymbolLink, TestFunctionRow } from "../types/analysis.js";
import type { FileTestCoverage } from "./test-coverage.js";
import { byOrdinal } from "./ordinal.js";
import { isTestFile } from "./test-file-detector.js";

/** Every test function of the analysis, by file, in source order. Files without one are left out. */
export function collectTestFunctions(analyses: readonly FileAnalysis[]): Record<string, TestFunctionRow[]> {
  const out: Record<string, TestFunctionRow[]> = {};
  for (const a of analyses) {
    const rows: TestFunctionRow[] = [];
    const add = (symbol: string, fn: FileAnalysis["functions"][number]) => {
      if (!fn.testCase) return;
      rows.push({ symbol, line: fn.line, kind: fn.testCase.kind, title: fn.testCase.title, ...(fn.testCase.path.length ? { path: fn.testCase.path } : {}) });
    };
    for (const fn of a.functions) add(fn.name, fn);
    for (const c of a.classes) for (const m of c.methods) add(`${c.name}.${m.name}`, m);
    if (rows.length) out[a.filePath] = rows.sort((x, y) => x.line - y.line);
  }
  return out;
}

/** Whether a file or a symbol in it is test code, and the test row a symbol is. */
export interface TestCodeIndex {
  /** A test file (the layer map's verdict, else the path conventions). */
  isTestFile(file: string): boolean;
  /** Test code: in a test file, or a test function declared beside production code. */
  isTest(file: string, symbol: string): boolean;
  /** The marked test function `symbol` is, when it is one. */
  testOf(file: string, symbol: string): TestFunctionRow | undefined;
}

export function testCodeIndex(summary: Pick<ProjectAnalysis, "fileLayerMap" | "testFunctions">): TestCodeIndex {
  const bySymbol = new Map<string, TestFunctionRow>();
  for (const [file, rows] of Object.entries(summary.testFunctions ?? {})) for (const r of rows) bySymbol.set(`${file}\0${r.symbol}`, r);
  const testFile = (f: string) => summary.fileLayerMap?.[f] === "test" || isTestFile(f);
  return {
    isTestFile: testFile,
    isTest: (file, symbol) => testFile(file) || bySymbol.has(`${file}\0${symbol}`),
    testOf: (file, symbol) => bySymbol.get(`${file}\0${symbol}`),
  };
}

/**
 * The title path a runner's name filter selects a marked test by: a case or a
 * suite by its own path, a hook by the suite it runs in (an empty list for a
 * hook of the whole file — nothing narrower runs it).
 */
export function testFilterPath(row: TestFunctionRow): string[] {
  const path = row.path ?? [];
  return row.kind === "hook" ? path : [...path, row.title];
}

/** Past this many production callers a function is a hub: reach through it credits no test with what lies below. */
export const HUB_CALLERS = 20;

/**
 * The walk rule test crediting shares (`reverseSymbolReach`'s `follow`): from a function reached
 * on the way up to the tests, go on to any caller — unless the function is a hub of more than
 * `HUB_CALLERS` production callers, past which only the tests calling the hub itself count. A test
 * reaching it through one of its many other callers exercises the hub, not what lies below it.
 */
export function hubFollow(links: readonly SymbolLink[], testCode: TestCodeIndex): (key: string, link: SymbolLink) => boolean {
  const production = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.navigational || l.sourceSymbol.startsWith("(") || l.sourceSymbol.startsWith("route:") || testCode.isTest(l.sourceFile, l.sourceSymbol)) continue;
    const key = `${l.targetFile}::${l.targetSymbol}`;
    (production.get(key) ?? production.set(key, new Set()).get(key)!).add(`${l.sourceFile}::${l.sourceSymbol}`);
  }
  return (key, l) => (production.get(key)?.size ?? 0) <= HUB_CALLERS || testCode.isTest(l.sourceFile, l.sourceSymbol);
}

/** A test reaching a function: the nearest, how many calls away, and the chain of calls it takes. */
export interface TestReach {
  test: { file: string; symbol: string; line: number };
  depth: number;
  /** The functions between the test and the target, test side first (empty when the test calls it). */
  via: string[];
  /** Every test reaching it within the depth. */
  tests: number;
}

/**
 * For each target function, the tests that reach it through the call graph (up to `maxDepth`
 * calls, never on through a hub to its other callers), nearest first — one walk per target over
 * one index of the links. Navigational links and import references are not calls.
 */
export function testsReachingEach(
  summary: Pick<ProjectAnalysis, "symbolLinks" | "fileLayerMap" | "testFunctions">,
  targets: ReadonlyArray<{ file: string; symbol: string }>,
  maxDepth = 6,
): Map<string, TestReach> {
  return testReachWalker(summary, maxDepth)(targets);
}

/**
 * `testsReachingEach` with the link index built once: the returned function answers for any
 * targets, so a reader judging many files does not index the links per file.
 */
export function testReachWalker(
  summary: Pick<ProjectAnalysis, "symbolLinks" | "fileLayerMap" | "testFunctions">,
  maxDepth = 6,
  testCode: TestCodeIndex = testCodeIndex(summary),
): (targets: ReadonlyArray<{ file: string; symbol: string }>) => Map<string, TestReach> {
  const links = summary.symbolLinks ?? [];
  const follow = hubFollow(links, testCode);
  const callersOf = new Map<string, SymbolLink[]>();
  for (const l of links) {
    if (l.navigational || l.sourceSymbol.startsWith("(") || l.sourceSymbol.startsWith("route:")) continue;
    const key = `${l.targetFile}::${l.targetSymbol}`;
    (callersOf.get(key) ?? callersOf.set(key, []).get(key)!).push(l);
  }
  return (targets) => {
    const out = new Map<string, TestReach>();
    for (const t of targets) {
      const start = `${t.file}::${t.symbol}`;
      const parent = new Map<string, { from: string; link: SymbolLink }>();
      const seen = new Set([start]);
      let frontier = [start];
      let nearest: { key: string; link: SymbolLink; depth: number } | null = null;
      let count = 0;
      for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
        const next: string[] = [];
        for (const key of frontier) {
          for (const l of callersOf.get(key) ?? []) {
            if (depth > 1 && !follow(key, l)) continue;
            const caller = `${l.sourceFile}::${l.sourceSymbol}`;
            if (seen.has(caller)) continue;
            seen.add(caller);
            parent.set(caller, { from: key, link: l });
            if (testCode.isTest(l.sourceFile, l.sourceSymbol)) {
              count++;
              nearest ??= { key: caller, link: l, depth };
            }
            next.push(caller);
          }
        }
        frontier = next;
      }
      if (!nearest) continue;
      const via: string[] = [];
      for (let at = parent.get(nearest.key)!.from; at !== start; at = parent.get(at)!.from) via.push(at.slice(at.indexOf("::") + 2));
      out.set(start, {
        test: { file: nearest.link.sourceFile, symbol: nearest.link.sourceSymbol, line: nearest.link.sourceLine },
        depth: nearest.depth,
        via,
        tests: count,
      });
    }
    return out;
  };
}

/** What a file's test verdict rests on: a test file depending on it, a test reaching one of its functions, a coverage report that ran its lines. */
export type TestVerdictBasis = "importer" | "reached-function" | "coverage";

/**
 * Whether a file is tested, by the one rule every reader shares:
 * - `test_file` — test code itself (the layer map's verdict, else the path conventions);
 * - `nothing_to_test` — no function or method of its own (module-level `<setup>`, members the
 *   language generates and the tests it declares do not count), or no per-file analysis to read
 *   them from; the bases below are still reported;
 * - `tested` — a test file depends on it (component graph), a test reaches one of its functions
 *   through the call graph (`testsReachingEach`, six calls at most), or a coverage report ran
 *   some of its lines;
 * - `untested` — none of those.
 */
export interface FileTestVerdict {
  state: "tested" | "untested" | "nothing_to_test" | "test_file";
  basis: TestVerdictBasis[];
  /** For a test file: whether the layer map or only its path says so. */
  testFileBy?: "layer" | "path";
  /** Test functions the extractor marked in the file. */
  declared: TestFunctionRow[];
  /** Test files depending on it, ordinal order. */
  importers: string[];
  /** Its own functions and methods, the ones judged. */
  functions: Array<{ symbol: string; line: number }>;
  /** The nearest test reaching each function, keyed `${path}::${symbol}`. */
  reach: Map<string, TestReach>;
  /** Its row in the coverage report, when one names it with lines. */
  coverage?: FileTestCoverage;
}

/** The parts of an analysis `fileTestVerdict` reads, built once for many files. */
export interface TestVerdictContext {
  testCode: TestCodeIndex;
  testImportersOf(path: string): string[];
  reach(targets: ReadonlyArray<{ file: string; symbol: string }>): Map<string, TestReach>;
}

type VerdictSummary = Pick<ProjectAnalysis, "symbolLinks" | "fileLayerMap" | "testFunctions" | "componentGraph" | "testCoverage">;

export function testVerdictContext(summary: VerdictSummary): TestVerdictContext {
  const testCode = testCodeIndex(summary);
  let importers: Map<string, string[]> | undefined;
  let walker: ReturnType<typeof testReachWalker> | undefined;
  return {
    testCode,
    testImportersOf(path) {
      if (!importers) {
        importers = new Map();
        for (const [from, deps] of Object.entries(summary.componentGraph ?? {})) {
          if (!testCode.isTestFile(from)) continue;
          for (const to of new Set(deps)) if (to !== from) (importers.get(to) ?? importers.set(to, []).get(to)!).push(from);
        }
        for (const list of importers.values()) list.sort(byOrdinal);
      }
      return importers.get(path) ?? [];
    },
    reach(targets) {
      walker ??= testReachWalker(summary, 6, testCode);
      return walker(targets);
    },
  };
}

export function fileTestVerdict(
  summary: VerdictSummary,
  path: string,
  file: Pick<FileAnalysis, "functions" | "classes"> | null | undefined,
  ctx: TestVerdictContext = testVerdictContext(summary),
): FileTestVerdict {
  const declared = summary.testFunctions?.[path] ?? [];
  const reach = new Map<string, TestReach>();
  if (ctx.testCode.isTestFile(path)) {
    return { state: "test_file", basis: [], testFileBy: summary.fileLayerMap?.[path] === "test" ? "layer" : "path", declared, importers: [], functions: [], reach };
  }
  const basis: TestVerdictBasis[] = [];
  const importers = ctx.testImportersOf(path);
  if (importers.length) basis.push("importer");
  const own = new Set(declared.map((d) => d.symbol));
  const functions = file
    ? [
        ...file.functions.filter((fn) => fn.name !== "<setup>" && !fn.synthetic).map((fn) => ({ symbol: fn.name, line: fn.line })),
        ...file.classes.flatMap((c) => c.methods.filter((m) => !m.synthetic).map((m) => ({ symbol: `${c.name}.${m.name}`, line: m.line }))),
      ].filter((fn) => !own.has(fn.symbol))
    : [];
  if (functions.length) {
    for (const [k, v] of ctx.reach(functions.map((fn) => ({ file: path, symbol: fn.symbol })))) reach.set(k, v);
    if (reach.size) basis.push("reached-function");
  }
  const row = summary.testCoverage?.files.find((x) => x.file === path);
  const coverage = row && row.total > 0 ? row : undefined;
  if (coverage && coverage.covered > 0) basis.push("coverage");
  const state = !functions.length ? "nothing_to_test" : basis.length ? "tested" : "untested";
  return { state, basis, declared, importers, functions, reach, ...(coverage ? { coverage } : {}) };
}
