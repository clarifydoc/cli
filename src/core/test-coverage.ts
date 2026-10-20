import type { FileAnalysis } from "../types/analysis.js";
import { trimTrailingSlashes } from "../extractors/plugins/shared/path-utils.js";

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
 */

export type CoverageFormat = "lcov" | "cobertura" | "jacoco" | "clover" | "go";

/** Line → hit count, per file path as the report writes it. */
export type LineHits = Map<string, Map<number, number>>;

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

export function parseCoverage(text: string): { format: CoverageFormat; hits: LineHits } | null {
  const format = detectFormat(text);
  if (!format) return null;
  const parse = { lcov: parseLcov, cobertura: parseCobertura, jacoco: parseJacoco, clover: parseClover, go: parseGoCover }[format];
  return { format, hits: parse(text) };
}

/** Where test runners write their reports by default, tried when none is named. */
export const COVERAGE_CANDIDATES = [
  "coverage/lcov.info", "lcov.info", "coverage/cobertura-coverage.xml", "coverage.xml", "coverage/coverage.xml",
  "coverage/clover.xml", "clover.xml", "build/logs/clover.xml",
  "target/site/jacoco/jacoco.xml", "build/reports/jacoco/test/jacocoTestReport.xml",
  "coverage.out", "cover.out", "coverage.txt",
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
  /** Lines the report counts (executable lines), and those a test ran. */
  total: number;
  covered: number;
  /** The lines no test ran, as ranges (`3-5,9`). */
  uncovered: string;
  /** Per function over its span, for the functions with counted lines. */
  functions?: Array<{ name: string; line: number; endLine: number; total: number; covered: number }>;
}

export interface TestCoverageReport {
  sources: Array<{ file: string; format: CoverageFormat; files: number; matched: number; stale: boolean }>;
  total: number;
  covered: number;
  files: FileTestCoverage[];
  /** Report paths that named no analyzed file (first 50). */
  unmatched: string[];
}

/** Join parsed reports to the analyzed files. `stale(file)` says a source changed after the report was written. */
export function buildTestCoverage(
  reports: ReadonlyArray<{ file: string; format: CoverageFormat; hits: LineHits; stale: (matched: string[]) => boolean }>,
  analyses: readonly FileAnalysis[],
  projectRoot: string,
): TestCoverageReport | undefined {
  const byBasename = new Map<string, string[]>();
  for (const a of analyses) {
    const base = a.filePath.slice(a.filePath.lastIndexOf("/") + 1);
    (byBasename.get(base) ?? byBasename.set(base, []).get(base)!).push(a.filePath);
  }
  const merged = new Map<string, Map<number, number>>();
  const unmatched: string[] = [];
  const sources: TestCoverageReport["sources"] = [];
  for (const r of reports) {
    const matched: string[] = [];
    for (const [path, lines] of r.hits) {
      const file = matchReportPath(path, projectRoot, byBasename);
      if (!file) {
        if (unmatched.length < 50) unmatched.push(path);
        continue;
      }
      matched.push(file);
      const into = merged.get(file) ?? merged.set(file, new Map()).get(file)!;
      for (const [n, c] of lines) into.set(n, Math.max(into.get(n) ?? 0, c));
    }
    sources.push({ file: r.file, format: r.format, files: r.hits.size, matched: matched.length, stale: matched.length > 0 && r.stale(matched) });
  }
  if (merged.size === 0 && sources.length === 0) return undefined;

  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  const files: FileTestCoverage[] = [];
  let total = 0;
  let covered = 0;
  for (const [file, lines] of [...merged].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const counted = [...lines];
    const run = counted.filter(([, c]) => c > 0).length;
    total += counted.length;
    covered += run;
    const a = byPath.get(file);
    const spans = a ? [...a.functions, ...a.classes.flatMap((c) => c.methods ?? [])].filter((f) => f.line && f.endLine >= f.line && !f.name.startsWith("<")) : [];
    const seen = new Set<string>();
    const functions: NonNullable<FileTestCoverage["functions"]> = [];
    for (const f of spans) {
      const key = `${f.line}:${f.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const inside = counted.filter(([n]) => n >= f.line && n <= f.endLine);
      if (inside.length === 0) continue;
      functions.push({ name: f.name, line: f.line, endLine: f.endLine, total: inside.length, covered: inside.filter(([, c]) => c > 0).length });
    }
    files.push({
      file,
      total: counted.length,
      covered: run,
      uncovered: lineRanges(counted.filter(([, c]) => c === 0).map(([n]) => n)),
      ...(functions.length ? { functions: functions.sort((x, y) => x.line - y.line) } : {}),
    });
  }
  return { sources, total, covered, files, unmatched };
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
