/**
 * The test functions the extractors marked (`FunctionInfo.testCase`), gathered
 * per file into `ProjectAnalysis.testFunctions`, and the one place readers ask
 * whether a caller is test code: a test file by path, or a test declared beside
 * production code (a Rust `#[cfg(test)]` module, a Zig `test` block).
 */

import type { FileAnalysis, ProjectAnalysis, TestFunctionRow } from "../types/analysis.js";
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
