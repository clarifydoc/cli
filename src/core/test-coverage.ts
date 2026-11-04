import type { FileAnalysis, TestFunctionRow } from "../types/analysis.js";
import { trimTrailingSlashes } from "../extractors/plugins/shared/path-utils.js";
import { collectTestFunctions } from "./test-functions.js";

/**
 * Test coverage, read from the report a test run wrote — lcov, Cobertura
 * (coverage.py writes it too), JaCoCo, Clover, Go coverprofile — and joined
 * to the map: per file, the lines a test ran and the ones none did; per
 * function, the same over its span. Format-level parsers: no language
 * knowledge, so any language a runner reports on is covered.
 *
 * Paths are matched by suffix against the analyzed tree, so a report written
 * in CI (`/home/runner/work/app/app/src/x.ts`, `github.com/org/app/pkg/x.go`)
 * joins the files here. A report path that ends in two analyzed files equally
 * well joins neither. Each record's lines are its own: nothing carries over
 * from the record before.
 *
 * Some reports keep the test dimension — per-test lcov (`TN:` per record),
 * coverage.py's JSON with `--show-contexts` and its `.coverage` data file with
 * test contexts: for those, each function also records which tests ran it
 * (measured evidence, against the call graph's guess). A report without it
 * says so (`sources[].tests === 0`).
 */

export type CoverageFormat = "lcov" | "cobertura" | "jacoco" | "clover" | "go" | "coveragepy-json" | "coveragepy-db";

/** Line → hit count, per file path as the report writes it. */
export type LineHits = Map<string, Map<number, number>>;

/** Per-test reach: file path as the report writes it → test id → the lines that test ran there. */
export type TestRuns = Map<string, Map<string, Set<number>>>;

function addRun(tests: TestRuns, file: string, test: string, line: number): void {
  if (!file || !test || !Number.isFinite(line) || line < 1) return;
  const byTest = tests.get(file) ?? tests.set(file, new Map()).get(file)!;
  (byTest.get(test) ?? byTest.set(test, new Set()).get(test)!).add(line);
}

/**
 * A coverage.py context as a test id: the phase pytest-cov appends
 * (`|run`, `|setup`, `|teardown`) dropped, so a test's fixtures count as the
 * test. The empty context — code run outside any test, imports — is no test.
 */
export function testContextId(context: string): string {
  return context.replace(/\|(?:run|setup|teardown)$/, "").trim();
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

function add(hits: LineHits, file: string, line: number, count: number): void {
  if (!file || !Number.isFinite(line) || line < 1) return;
  const lines = hits.get(file) ?? hits.set(file, new Map()).get(file)!;
  // Several entries on one line (Go blocks, two classes): it ran if any of them did.
  lines.set(line, Math.max(lines.get(line) ?? 0, count));
}

export function detectFormat(text: string): CoverageFormat | null {
  const head = text.slice(0, 4000);
  if (/^mode:\s*(set|count|atomic)\s*$/m.test(head)) return "go";
  if (/^SF:/m.test(head) || /^TN:/m.test(head)) return "lcov";
  if (/^\s*\{/.test(head) && /"meta"\s*:/.test(head) && /"files"\s*:/.test(head) && /"executed_lines"\s*:/.test(text.slice(0, 200_000))) return "coveragepy-json";
  if (/<report\b/.test(head) && /jacoco|<sessioninfo|<package\b/i.test(text.slice(0, 20000))) return "jacoco";
  if (/<coverage\b[^>]*\bgenerated=/.test(head) && /<project\b/.test(text.slice(0, 20000))) return "clover";
  if (/<coverage\b/.test(head)) return "cobertura";
  return null;
}

export function parseLcov(text: string): LineHits {
  const hits: LineHits = new Map();
  let file = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) file = line.slice(3);
    else if (line.startsWith("DA:") && file) {
      const [n, c] = line.slice(3).split(",");
      add(hits, file, Number(n), Number(c));
    } else if (line === "end_of_record") file = "";
  }
  return hits;
}

/**
 * The tests a per-test lcov names (`TN:<name>`, standing until the next one),
 * with the lines each ran. Undefined unless two distinct names appear: a
 * merged report has one name for every record, or a blank one.
 */
export function lcovTestRuns(text: string): TestRuns | undefined {
  const tests: TestRuns = new Map();
  const names = new Set<string>();
  let test = "";
  let file = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("TN:")) {
      test = line.slice(3).trim();
      if (test) names.add(test);
    } else if (line.startsWith("SF:")) file = line.slice(3);
    else if (line.startsWith("DA:") && file && test) {
      const [n, c] = line.slice(3).split(",");
      if (Number(c) > 0) addRun(tests, file, test, Number(n));
    } else if (line === "end_of_record") file = "";
  }
  return names.size >= 2 ? tests : undefined;
}

/**
 * coverage.py's JSON report: per file, `executed_lines` and `missing_lines`,
 * and with `--show-contexts` `contexts: { "<line>": ["<context>", …] }`.
 */
export function parseCoveragePyJson(text: string): { hits: LineHits; tests?: TestRuns } {
  const hits: LineHits = new Map();
  const tests: TestRuns = new Map();
  let doc: { files?: Record<string, { executed_lines?: number[]; missing_lines?: number[]; contexts?: Record<string, string[]> }> };
  try {
    doc = JSON.parse(text);
  } catch {
    return { hits };
  }
  for (const [file, f] of Object.entries(doc.files ?? {})) {
    if (!f || typeof f !== "object") continue;
    for (const n of f.executed_lines ?? []) add(hits, file, Number(n), 1);
    for (const n of f.missing_lines ?? []) add(hits, file, Number(n), 0);
    for (const [n, contexts] of Object.entries(f.contexts ?? {})) {
      if (!Array.isArray(contexts)) continue;
      for (const c of contexts) if (typeof c === "string") addRun(tests, file, testContextId(c), Number(n));
    }
  }
  return tests.size ? { hits, tests } : { hits };
}

export function parseCobertura(text: string): LineHits {
  const hits: LineHits = new Map();
  const sources = [...text.matchAll(/<source>([^<]*)<\/source>/g)].map((m) => m[1]!.trim().replace(/\\/g, "/").replace(/\/+$/, ""));
  for (const m of text.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const filename = attr(m[1]!, "filename");
    if (!filename) continue;
    // A relative filename is under one of the <source> roots; the suffix match picks the analyzed file.
    const file = sources.length === 1 && !filename.startsWith("/") ? `${sources[0]}/${filename}` : filename;
    for (const l of m[2]!.matchAll(/<line\b([^>]*)\/?>/g)) add(hits, file, Number(attr(l[1]!, "number")), Number(attr(l[1]!, "hits") ?? 0));
  }
  return hits;
}

export function parseJacoco(text: string): LineHits {
  const hits: LineHits = new Map();
  for (const p of text.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
    const pkg = attr(p[1]!, "name") ?? "";
    for (const sf of p[2]!.matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
      const name = attr(sf[1]!, "name");
      if (!name) continue;
      const file = pkg ? `${pkg}/${name}` : name;
      // ci: covered instructions on the line — it ran when any did.
      for (const l of sf[2]!.matchAll(/<line\b([^>]*)\/?>/g)) add(hits, file, Number(attr(l[1]!, "nr")), Number(attr(l[1]!, "ci") ?? 0));
    }
  }
  return hits;
}

export function parseClover(text: string): LineHits {
  const hits: LineHits = new Map();
  for (const f of text.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/g)) {
    const file = attr(f[1]!, "path") ?? attr(f[1]!, "name");
    if (!file) continue;
    for (const l of f[2]!.matchAll(/<line\b([^>]*)\/?>/g)) {
      // A `method` line is the declaration; the statements say what ran.
      if (attr(l[1]!, "type") === "method") continue;
      add(hits, file, Number(attr(l[1]!, "num")), Number(attr(l[1]!, "count") ?? 0));
    }
  }
  return hits;
}

export function parseGoCover(text: string): LineHits {
  const hits: LineHits = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)\s*$/.exec(raw.trim());
    if (!m) continue;
    for (let n = Number(m[2]); n <= Number(m[3]); n++) add(hits, m[1]!, n, Number(m[4]));
  }
  return hits;
}

export function parseCoverage(text: string): { format: CoverageFormat; hits: LineHits; tests?: TestRuns } | null {
  const format = detectFormat(text);
  if (!format || format === "coveragepy-db") return null;
  if (format === "coveragepy-json") return { format, ...parseCoveragePyJson(text) };
  if (format === "lcov") {
    const tests = lcovTestRuns(text);
    return { format, hits: parseLcov(text), ...(tests ? { tests } : {}) };
  }
  const parse = { cobertura: parseCobertura, jacoco: parseJacoco, clover: parseClover, go: parseGoCover }[format];
  return { format, hits: parse(text) };
}

/** An SQLite database file, by its header — coverage.py's `.coverage` is one. */
export function isSqliteFile(head: Uint8Array): boolean {
  return Buffer.from(head.subarray(0, 16)).toString("latin1") === "SQLite format 3\0";
}

/** coverage.py's numbits: line n is bit n%8 of byte n//8. */
export function numbitsLines(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b) for (let bit = 0; bit < 8; bit++) if (b & (1 << bit)) out.push(i * 8 + bit);
  }
  return out;
}

/**
 * coverage.py's data file (`.coverage`, SQLite): the lines each test context
 * ran, from `line_bits` or, in branch mode, the positive ends of `arc`. It
 * records what ran, never what could have — so no hit counts, no percentage:
 * per-test reach only. A file whose only context is the empty one has none.
 * `node:sqlite` is loaded on demand; without it (Node before 22.13) the
 * report is not read and `unread` says why.
 */
export async function readCoverageDb(path: string): Promise<{ format: "coveragepy-db"; hits: LineHits; tests?: TestRuns } | { unread: string }> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return { unread: `node:sqlite is not available in Node ${process.versions.node} (22.13 or later reads it)` };
  }
  let db: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  let result: { format: "coveragepy-db"; hits: LineHits; tests?: TestRuns } | { unread: string };
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    result = readCoverageTables(db);
  } catch (e) {
    result = { unread: `could not be read (${(e as Error).message})` };
  }
  try {
    db?.close();
  } catch {
    // Already closed.
  }
  return result;
}

function readCoverageTables(db: import("node:sqlite").DatabaseSync): { format: "coveragepy-db"; hits: LineHits; tests?: TestRuns } | { unread: string } {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
  if (!tables.has("file") || !tables.has("context")) return { unread: "not a coverage.py data file (no file or context table)" };
  const files = new Map((db.prepare("SELECT id, path FROM file").all() as Array<{ id: number; path: string }>).map((r) => [r.id, r.path]));
  const contexts = new Map<number, string>();
  for (const r of db.prepare("SELECT id, context FROM context").all() as Array<{ id: number; context: string }>) {
    const id = testContextId(r.context ?? "");
    if (id) contexts.set(r.id, id);
  }
  const tests: TestRuns = new Map();
  if (contexts.size && tables.has("line_bits")) {
    for (const r of db.prepare("SELECT file_id, context_id, numbits FROM line_bits").iterate() as Iterable<{ file_id: number; context_id: number; numbits: Uint8Array }>) {
      const test = contexts.get(r.context_id);
      const file = files.get(r.file_id);
      if (!test || !file || !r.numbits) continue;
      for (const n of numbitsLines(r.numbits)) addRun(tests, file, test, n);
    }
  }
  if (contexts.size && tables.has("arc")) {
    for (const r of db.prepare("SELECT file_id, context_id, fromno, tono FROM arc").iterate() as Iterable<{ file_id: number; context_id: number; fromno: number; tono: number }>) {
      const test = contexts.get(r.context_id);
      const file = files.get(r.file_id);
      if (!test || !file) continue;
      // A negative end is a code object's entry or exit, not a line that ran.
      if (r.fromno > 0) addRun(tests, file, test, r.fromno);
      if (r.tono > 0) addRun(tests, file, test, r.tono);
    }
  }
  return { format: "coveragepy-db", hits: new Map(), ...(tests.size ? { tests } : {}) };
}

/** Where test runners write their reports by default, tried when none is named. */
export const COVERAGE_CANDIDATES = [
  "coverage/lcov.info", "lcov.info", "coverage/cobertura-coverage.xml", "coverage.xml", "coverage/coverage.xml",
  "coverage/clover.xml", "clover.xml", "build/logs/clover.xml",
  "target/site/jacoco/jacoco.xml", "build/reports/jacoco/test/jacocoTestReport.xml",
  "coverage.out", "cover.out", "coverage.txt",
  "coverage.json", ".coverage",
];

/**
 * The analyzed file a report path names: the longest analyzed path it ends
 * with, or the one whose path ends with it. Undefined when none does, or two
 * do equally well.
 */
export function matchReportPath(reportPath: string, projectRoot: string, byBasename: Map<string, string[]>): string | undefined {
  let p = reportPath.replace(/\\/g, "/").replace(/^file:\/\//, "").replace(/^[A-Za-z]:/, "");
  const root = trimTrailingSlashes(projectRoot.replace(/\\/g, "/"));
  if (p.startsWith(root + "/")) p = p.slice(root.length + 1);
  p = p.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  const base = p.slice(p.lastIndexOf("/") + 1);
  const candidates = (byBasename.get(base) ?? []).filter((f) => f === p || p.endsWith("/" + f) || f.endsWith("/" + p));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  // The candidate sharing the most trailing segments with the report path.
  const shared = (f: string) => {
    const a = f.split("/").reverse();
    const b = p.split("/").reverse();
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };
  const scored = candidates.map((f) => [f, shared(f)] as const).sort((x, y) => y[1] - x[1]);
  return scored[0]![1] > scored[1]![1] ? scored[0]![0] : undefined;
}

/** `3-5,9,12-14`: line numbers as compact ranges. */
export function lineRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out.join(",");
}

export interface FileTestCoverage {
  file: string;
  /** Lines the report counts (executable lines), and those a test ran. 0 when only a ran-lines report (`.coverage`) names the file. */
  total: number;
  covered: number;
  /** The lines no test ran, as ranges (`3-5,9`). */
  uncovered: string;
  /**
   * Per function over its span, for the functions with counted lines or a
   * test that ran one. `tests`: the tests a per-test report saw run its lines,
   * as indices into `TestCoverageReport.tests` — those that ran most of it
   * first, at most `MAX_TESTS_PER_FUNCTION`; `testCount` counts them all.
   */
  functions?: Array<{ name: string; line: number; endLine: number; total: number; covered: number; tests?: number[]; testCount?: number }>;
}

/**
 * A test a per-test report names: its `id` as the report writes it (the
 * phase suffix dropped), the analyzed file its path names, and `symbol` as
 * the linker spells it; `line` is set when the analysis declares that symbol
 * — a marked test function (`ProjectAnalysis.testFunctions`) first, else a
 * function of that name in the file.
 */
export interface CoverageTest {
  id: string;
  file?: string;
  symbol?: string;
  line?: number;
}

export interface TestCoverageReport {
  /**
   * The reports read. `tests`: how many distinct tests the report names lines
   * for — 0 for an aggregate-only report (absent in summaries written before
   * it was read). `unread`: why a report found was not read.
   */
  sources: Array<{ file: string; format: CoverageFormat; files: number; matched: number; stale: boolean; tests?: number; unread?: string }>;
  total: number;
  covered: number;
  files: FileTestCoverage[];
  /** Report paths that named no analyzed file (first 50). */
  unmatched: string[];
  /** The tests the functions' `tests` indices name, by id. Absent without a per-test report. */
  tests?: CoverageTest[];
}

/** Tests kept per function; `testCount` says how many ran it. */
export const MAX_TESTS_PER_FUNCTION = 12;

/** A report as `buildTestCoverage` takes it. */
export interface CoverageReportInput {
  file: string;
  format: CoverageFormat;
  hits: LineHits;
  tests?: TestRuns;
  /** Why the report was not read; it is listed with nothing from it. */
  unread?: string;
  stale: (matched: string[]) => boolean;
}

/** Join parsed reports to the analyzed files. `stale(file)` says a source changed after the report was written. */
export function buildTestCoverage(
  reports: ReadonlyArray<CoverageReportInput>,
  analyses: readonly FileAnalysis[],
  projectRoot: string,
): TestCoverageReport | undefined {
  const byBasename = new Map<string, string[]>();
  for (const a of analyses) {
    const base = a.filePath.slice(a.filePath.lastIndexOf("/") + 1);
    (byBasename.get(base) ?? byBasename.set(base, []).get(base)!).push(a.filePath);
  }
  const merged = new Map<string, Map<number, number>>();
  // Analyzed file → test id → the lines it ran there.
  const runs = new Map<string, Map<string, Set<number>>>();
  const unmatched: string[] = [];
  const unmatchedSeen = new Set<string>();
  const noteUnmatched = (path: string) => {
    if (unmatched.length < 50 && !unmatchedSeen.has(path)) {
      unmatchedSeen.add(path);
      unmatched.push(path);
    }
  };
  const sources: TestCoverageReport["sources"] = [];
  for (const r of reports) {
    if (r.unread) {
      sources.push({ file: r.file, format: r.format, files: 0, matched: 0, stale: false, tests: 0, unread: r.unread });
      continue;
    }
    const matched = new Set<string>();
    for (const [path, lines] of r.hits) {
      const file = matchReportPath(path, projectRoot, byBasename);
      if (!file) {
        noteUnmatched(path);
        continue;
      }
      matched.add(file);
      const into = merged.get(file) ?? merged.set(file, new Map()).get(file)!;
      for (const [n, c] of lines) into.set(n, Math.max(into.get(n) ?? 0, c));
    }
    const named = new Set<string>();
    for (const [path, byTest] of r.tests ?? []) {
      const file = matchReportPath(path, projectRoot, byBasename);
      if (!file) {
        noteUnmatched(path);
        continue;
      }
      matched.add(file);
      const into = runs.get(file) ?? runs.set(file, new Map()).get(file)!;
      for (const [test, lines] of byTest) {
        named.add(test);
        const set = into.get(test) ?? into.set(test, new Set()).get(test)!;
        for (const n of lines) set.add(n);
      }
    }
    const files = new Set([...r.hits.keys(), ...(r.tests?.keys() ?? [])]).size;
    sources.push({ file: r.file, format: r.format, files, matched: matched.size, stale: matched.size > 0 && r.stale([...matched]), tests: named.size });
  }
  if (merged.size === 0 && runs.size === 0 && sources.length === 0) return undefined;

  const resolve = testResolver(analyses, projectRoot, byBasename);
  const tableIndex = new Map<string, number>();
  const table: CoverageTest[] = [];
  const indexOf = (id: string): number => {
    let i = tableIndex.get(id);
    if (i === undefined) {
      i = table.length;
      tableIndex.set(id, i);
      table.push(resolve(id));
    }
    return i;
  };

  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  const files: FileTestCoverage[] = [];
  let total = 0;
  let covered = 0;
  for (const file of [...new Set([...merged.keys(), ...runs.keys()])].sort((a, b) => (a < b ? -1 : 1))) {
    const counted = [...(merged.get(file) ?? [])];
    const ran = runs.get(file);
    const run = counted.filter(([, c]) => c > 0).length;
    total += counted.length;
    covered += run;
    const a = byPath.get(file);
    const spans = a ? [...a.functions, ...a.classes.flatMap((c) => (c.methods ?? []).map((m) => ({ ...m, owner: c.name })))].filter((f) => f.line && f.endLine >= f.line && !f.name.startsWith("<")) : [];
    const seen = new Set<string>();
    const functions: NonNullable<FileTestCoverage["functions"]> = [];
    for (const f of spans) {
      const key = `${f.line}:${f.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const inside = counted.filter(([n]) => n >= f.line && n <= f.endLine);
      // The tests that ran a line of it, by how many of its lines each ran.
      const ranBy: Array<[string, number]> = [];
      for (const [test, lines] of ran ?? []) {
        let n = 0;
        for (const l of lines) if (l >= f.line && l <= f.endLine) n++;
        if (n) ranBy.push([test, n]);
      }
      if (inside.length === 0 && ranBy.length === 0) continue;
      const row: NonNullable<FileTestCoverage["functions"]>[number] = { name: f.name, line: f.line, endLine: f.endLine, total: inside.length, covered: inside.filter(([, c]) => c > 0).length };
      // A test function running its own lines is no evidence about it.
      const self = "owner" in f ? `${f.owner}.${f.name}` : f.name;
      const others = ranBy.filter(([test]) => {
        const t = resolve(test);
        return !(t.file === file && t.symbol === self);
      });
      if (others.length) {
        others.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
        row.tests = others.slice(0, MAX_TESTS_PER_FUNCTION).map(([test]) => indexOf(test));
        row.testCount = others.length;
      }
      functions.push(row);
    }
    files.push({
      file,
      total: counted.length,
      covered: run,
      uncovered: lineRanges(counted.filter(([, c]) => c === 0).map(([n]) => n)),
      ...(functions.length ? { functions: functions.sort((x, y) => x.line - y.line) } : {}),
    });
  }
  return { sources, total, covered, files, unmatched, ...(table.length ? { tests: table } : {}) };
}

/**
 * Test id → the test it is in the analysis. A pytest node id
 * (`tests/test_club.py::TestClub::test_save[home]`) splits at `::` into the
 * file and the names; a dotted name (`tests.test_club.TestClub.test_save`)
 * is tried as module path + names, longest module first; any other name
 * (an lcov `TN:`) is matched to the one marked test of that name. Parameters
 * in brackets are dropped from the symbol. An id naming no analyzed file is
 * kept as written.
 */
function testResolver(analyses: readonly FileAnalysis[], projectRoot: string, byBasename: Map<string, string[]>): (id: string) => CoverageTest {
  const marked = collectTestFunctions(analyses);
  const stems = new Map<string, string[]>();
  for (const a of analyses) {
    const stem = a.filePath.replace(/\.[^./]+$/, "");
    const last = stem.slice(stem.lastIndexOf("/") + 1);
    (stems.get(last) ?? stems.set(last, []).get(last)!).push(a.filePath);
  }
  const byLeaf = new Map<string, Array<{ file: string; row: TestFunctionRow }>>();
  for (const [file, rows] of Object.entries(marked)) {
    for (const row of rows) {
      if (row.kind === "suite") continue;
      for (const k of new Set([row.symbol.split(".").pop()!, row.title])) (byLeaf.get(k) ?? byLeaf.set(k, []).get(k)!).push({ file, row });
    }
  }
  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  // A marked test first; else the function the file declares under that name (a language whose tests are not marked).
  const inFile = (file: string, names: string[]): CoverageTest => {
    const clean = names.map((n) => n.replace(/\[.*\]$/, "")).filter(Boolean);
    const symbol = clean.join(".");
    const leaf = clean[clean.length - 1];
    const rows = (marked[file] ?? []).filter((r) => r.kind !== "suite");
    const row = rows.find((r) => r.symbol === symbol) ?? (leaf ? onlyOne(rows.filter((r) => r.symbol.split(".").pop() === leaf)) : undefined);
    if (row) return { id: "", file, symbol: row.symbol, line: row.line };
    const a = byPath.get(file);
    const declared = a ? [...a.functions.map((f) => ({ symbol: f.name, line: f.line })), ...a.classes.flatMap((c) => (c.methods ?? []).map((m) => ({ symbol: `${c.name}.${m.name}`, line: m.line })))] : [];
    const fn = declared.find((d) => d.symbol === symbol) ?? (leaf ? onlyOne(declared.filter((d) => d.symbol.split(".").pop() === leaf)) : undefined);
    if (fn) return { id: "", file, symbol: fn.symbol, line: fn.line };
    return { id: "", file, ...(symbol ? { symbol } : {}) };
  };
  const cache = new Map<string, CoverageTest>();
  return (id) => {
    const hit = cache.get(id);
    if (hit) return hit;
    let out: CoverageTest = { id };
    if (id.includes("::")) {
      const [path, ...names] = id.split("::");
      const file = matchReportPath(path!, projectRoot, byBasename);
      if (file) out = { ...inFile(file, names), id };
    } else if (/^[\w.]+(\[.*\])?$/.test(id) && id.includes(".")) {
      const parts = id.split(".");
      for (let k = parts.length - 1; k >= 1; k--) {
        const module = parts.slice(0, k).join("/");
        const file = onlyOne((stems.get(parts[k - 1]!) ?? []).filter((f) => {
          const stem = f.replace(/\.[^./]+$/, "");
          return stem === module || stem.endsWith("/" + module);
        }));
        if (file) {
          out = { ...inFile(file, parts.slice(k)), id };
          break;
        }
      }
    }
    if (!out.file) {
      const one = onlyOne(byLeaf.get(id) ?? []);
      if (one) out = { id, file: one.file, symbol: one.row.symbol, line: one.row.line };
    }
    cache.set(id, out);
    return out;
  };
}

function onlyOne<T>(xs: readonly T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined;
}

/** The reports that name tests, for a sentence saying where per-test evidence comes from. */
export function perTestSources(report: Pick<TestCoverageReport, "sources">): string[] {
  return (report.sources ?? []).filter((s) => (s.tests ?? 0) > 0).map((s) => s.file);
}

/**
 * Said once when every report read is aggregate-only: per-test evidence is
 * unavailable, not absent. Undefined when a report names tests, or when the
 * summary predates per-test reading.
 */
export function aggregateOnlyNote(report: Pick<TestCoverageReport, "sources">): string | undefined {
  const read = (report.sources ?? []).filter((s) => !s.unread);
  if (!read.length || read.some((s) => s.tests === undefined || s.tests > 0)) return undefined;
  const names = read.map((s) => s.file);
  return `${names.length === 1 ? `${names[0]} records` : `${names.join(", ")} record`} no test contexts (aggregate-only): ${names.length === 1 ? "it says" : "they say"} a line ran, never which test ran it`;
}

/** The tests a coverage function row names, resolved, and how many ran it. */
export function testsOfCoverageFunction(report: Pick<TestCoverageReport, "tests">, fn: { tests?: number[]; testCount?: number }): { tests: CoverageTest[]; count: number } {
  const tests = (fn.tests ?? []).map((i) => report.tests?.[i]).filter((t): t is CoverageTest => !!t);
  return { tests, count: fn.testCount ?? tests.length };
}

/**
 * How much of what a route runs the tests ran: the handler and the project
 * functions it calls, up to `depth` calls away over resolved links, summed
 * over the functions a coverage report counts. A route whose reach has counted
 * lines and none run is untested — whatever breaks there, no test says so.
 * Keyed `<file>\u0000<METHOD> <path>` (the route's file and label).
 */
export function routeTestCoverage(
  routes: ReadonlyArray<{ filePath: string; kind: string; httpMethod: string | null; path: string }>,
  symbolLinks: ReadonlyArray<{ sourceFile: string; sourceSymbol: string; targetFile: string; targetSymbol: string; confidence?: string; navigational?: boolean }>,
  coverage: TestCoverageReport,
  depth = 3,
): Map<string, { covered: number; total: number; functions: number }> {
  const byFile = new Map(coverage.files.map((f) => [f.file, f]));
  const forward = new Map<string, Array<{ file: string; symbol: string }>>();
  for (const l of symbolLinks) {
    if (l.navigational || l.confidence === "AMBIGUOUS") continue;
    const k = `${l.sourceFile}\u0000${l.sourceSymbol}`;
    (forward.get(k) ?? forward.set(k, []).get(k)!).push({ file: l.targetFile, symbol: l.targetSymbol });
  }
  const counted = (file: string, symbol: string) => {
    const leaf = symbol.split(".").pop()!;
    return byFile.get(file)?.functions?.find((f) => f.name === symbol || f.name.endsWith(`.${leaf}`) || f.name === leaf);
  };
  const out = new Map<string, { covered: number; total: number; functions: number }>();
  for (const r of routes) {
    if (r.kind !== "api") continue;
    const label = `${(r.httpMethod ?? "USE").toUpperCase()} ${r.path}`;
    const start = `${r.filePath}\u0000route:${r.httpMethod ?? "USE"} ${r.path}`;
    const seen = new Set([start]);
    let frontier = [start];
    let covered = 0;
    let total = 0;
    let functions = 0;
    for (let d = 0; d < depth + 1 && frontier.length; d++) {
      const next: string[] = [];
      for (const key of frontier) {
        for (const t of forward.get(key) ?? []) {
          const tk = `${t.file}\u0000${t.symbol}`;
          if (seen.has(tk)) continue;
          seen.add(tk);
          next.push(tk);
          const fn = counted(t.file, t.symbol);
          if (fn && fn.total > 0) {
            covered += fn.covered;
            total += fn.total;
            functions++;
          }
        }
      }
      frontier = next;
    }
    if (functions > 0) out.set(`${r.filePath}\u0000${label}`, { covered, total, functions });
  }
  return out;
}

/** "3-5,9" → [3,4,5,9]: the lines a range list names. */
export function rangeLines(ranges: string): number[] {
  const out: number[] = [];
  for (const part of ranges.split(",")) {
    const m = /^\s*(\d+)(?:-(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= b && n - a < 100_000; n++) out.push(n);
  }
  return out;
}
