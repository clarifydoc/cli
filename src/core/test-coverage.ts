import type { FileAnalysis } from "../types/analysis.js";

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
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
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
