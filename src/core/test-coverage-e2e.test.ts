import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { computeImpactDiff } from "./impact-diff.js";

/** A coverage report found where the test runner writes it, written with CI's paths, joined to the map. */
describe("test coverage, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-cov-"));
    const root = join(dir, "app");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "coverage"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", dependencies: { express: "4.19.2" } }));
    await writeFile(join(root, "src", "math.ts"), [
      "export function add(a: number, b: number) {", // 1
      "  return a + b;",                               // 2
      "}",                                             // 3
      "export function risky(x: number) {",           // 4
      "  if (x > 1) return x * 2;",                    // 5
      "  return x;",                                    // 6
      "}",                                              // 7
    ].join("\n"));
    await writeFile(join(root, "src", "untouched.ts"), "export function never() {\n  return 1;\n}\n");
    await writeFile(join(root, "coverage", "lcov.info"), [
      "TN:", "SF:/home/runner/work/app/app/src/math.ts", "DA:2,4", "DA:5,0", "DA:6,0", "end_of_record",
      "SF:/home/runner/work/app/app/src/untouched.ts", "DA:2,0", "end_of_record",
      "SF:/home/runner/work/app/app/src/gone.ts", "DA:1,1", "end_of_record",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the report from coverage/lcov.info and joins its CI paths, per file and function", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const t = s.testCoverage!;
    expect(t.sources).toMatchObject([{ file: "coverage/lcov.info", format: "lcov", files: 3, matched: 2 }]);
    expect(t.unmatched).toEqual(["/home/runner/work/app/app/src/gone.ts"]);
    const math = t.files.find((f) => f.file === "src/math.ts")!;
    expect(math).toMatchObject({ total: 3, covered: 1, uncovered: "5-6" });
    expect(math.functions?.map((f) => `${f.name} ${f.covered}/${f.total}`)).toEqual(["add 1/1", "risky 0/2"]);
  });

  it("says in the impact of a change what no test runs", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const byFile = computeImpactDiff(s, ["src/untouched.ts", "src/math.ts"]);
    expect(byFile.untested).toEqual([{ file: "src/untouched.ts", lines: 1 }]);
    const bySymbol = computeImpactDiff(s, ["src/math.ts"], {
      symbols: { changed: [{ file: "src/math.ts", symbol: "add", line: 1, endLine: 3 }, { file: "src/math.ts", symbol: "risky", line: 4, endLine: 7 }], moduleLevel: [] },
    });
    expect(bySymbol.untested).toEqual([{ file: "src/math.ts", symbol: "risky", line: 4, lines: 2 }]);
    expect(bySymbol.risk.reasons.join("; ")).toContain("no test runs risky");
  });
});
