/**
 * The file test verdict (`fileTestVerdict`) and clarifydoc_file's tests section, which renders
 * it: each state on a small project, and the section's text pinned word for word so the shared
 * rule cannot drift from what the tool says.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../core/analyzer.js";
import { loadReportSummary } from "../core/report-payload.js";
import { fileTestVerdict, testVerdictContext } from "../core/test-functions.js";
import type { FileAnalysis, ProjectAnalysis } from "../types/analysis.js";
import { buildMcpServer } from "./server.js";

let dir = "";
const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-table", devDependencies: { vitest: "^2.0.0" } }),
  "src/table.ts": [
    "export function sortClubs(points: number[]): number[] { return [...points].sort(); }",
    "export function buildTable(points: number[]): string[] { return sortClubs(points).map(String); }",
    "export function relegate(points: number[]): number[] { return points.slice(0, -3); }",
  ].join("\n"),
  "src/transfers.ts": [
    "export function signPlayer(name: string): string { return name.trim(); }",
    "export class Window {",
    "  open(): boolean { return true; }",
    "}",
  ].join("\n"),
  "src/colours.ts": 'export const HOME = "red";\nexport const AWAY = "white";\n',
  "src/garage.ts": [
    "export function parkCar(bay: number): number {",
    "  if (bay > 3) return bay - 3;",
    "  return bay;",
    "}",
  ].join("\n"),
  "test/table.test.ts": [
    'import { describe, it, expect } from "vitest";',
    'import { buildTable } from "../src/table";',
    'describe("league", () => {',
    '  it("builds", () => {',
    "    expect(buildTable([3, 1])).toEqual([\"1\", \"3\"]);",
    "  });",
    "});",
  ].join("\n"),
  "coverage/lcov.info": ["SF:src/garage.ts", "DA:1,1", "DA:2,1", "DA:3,0", "end_of_record", ""].join("\n"),
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-file-verdict-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
    await writeFile(join(dir, "app", rel), text);
  }
  await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
}, 180_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fileTests(path: string): Promise<string> {
  const { server } = buildMcpServer({ projectRoot: join(dir, "app"), analysisDir: join(dir, "out"), allowAnalyze: false, allowColdStart: false, log: () => {} });
  const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_file", arguments: { path, sections: ["tests"] } } })) as { result: { content: Array<{ text: string }> } };
  const text = res.result.content[0]!.text;
  return text.slice(text.indexOf("## Tests"));
}

async function verdicts(): Promise<Record<string, { state: string; basis: string[] }>> {
  const summary: ProjectAnalysis = await loadReportSummary(join(dir, "out"));
  const ctx = testVerdictContext(summary);
  const out: Record<string, { state: string; basis: string[] }> = {};
  for (const path of ["src/table.ts", "src/transfers.ts", "src/colours.ts", "src/garage.ts", "test/table.test.ts"]) {
    const file = JSON.parse(await readFile(join(dir, "out", `${path}.json`), "utf-8")) as FileAnalysis;
    const v = fileTestVerdict(summary, path, file, ctx);
    out[path] = { state: v.state, basis: v.basis };
  }
  return out;
}

describe("fileTestVerdict", () => {
  it("calls each file tested, untested, nothing to test or a test file, with what it rests on", async () => {
    expect(await verdicts()).toEqual({
      "src/table.ts": { state: "tested", basis: ["importer", "reached-function"] },
      "src/transfers.ts": { state: "untested", basis: [] },
      "src/colours.ts": { state: "nothing_to_test", basis: [] },
      "src/garage.ts": { state: "tested", basis: ["coverage"] },
      "test/table.test.ts": { state: "test_file", basis: [] },
    });
  });

  it("gives the same verdict without a shared context", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const file = JSON.parse(await readFile(join(dir, "out", "src/table.ts.json"), "utf-8")) as FileAnalysis;
    const v = fileTestVerdict(summary, "src/table.ts", file);
    expect(v.importers).toEqual(["test/table.test.ts"]);
    expect([...v.reach.keys()].sort()).toEqual(["src/table.ts::buildTable", "src/table.ts::sortClubs"]);
    expect(fileTestVerdict(summary, "src/table.ts", null).state).toBe("nothing_to_test");
  });
});

const PINNED: Record<string, string[]> = {
  "src/table.ts": [
    "## Tests",
    "test files depending on it (1):",
    "  - test/table.test.ts — depends on it (component graph)",
    "tests reaching its functions — 2 of 3 reached through the call graph (six calls at most); none reaches relegate:",
    "  - sortClubs() line 1 ← league › builds test/table.test.ts:5 — 2 calls: league › builds → buildTable → sortClubs",
    "  - buildTable() line 2 ← league › builds test/table.test.ts:5 — calls it",
  ],
  "src/transfers.ts": [
    "## Tests",
    "tests reaching its functions — 0 of 2 reached through the call graph (six calls at most); none reaches signPlayer, Window.open:",
  ],
  "src/colours.ts": [
    "## Tests",
    "no test imports it, no test reaches its functions, and no coverage report names it",
  ],
  "src/garage.ts": [
    "## Tests",
    "tests reaching its functions — 0 of 1 reached through the call graph (six calls at most); none reaches parkCar:",
    "coverage: 67% of 3 lines ran (coverage/lcov.info); not run: lines 3",
    "per-test evidence unavailable: coverage/lcov.info records no test contexts (aggregate-only): it says a line ran, never which test ran it",
  ],
  "test/table.test.ts": [
    "## Tests",
    "a test file (its layer)",
    "declares 2 test functions (cases: 1, suites: 1) — marked by the extractor:",
    "  - league [suite] (line 3)",
    "  - league › builds [case] (line 4)",
    "calls into production code (1 functions):",
    "  - buildTable() src/table.ts:2 ← league › builds (line 5)",
  ],
};

describe("clarifydoc_file tests section, word for word", () => {
  for (const [path, lines] of Object.entries(PINNED)) {
    it(path, async () => {
      expect(await fileTests(path)).toBe(lines.join("\n"));
    });
  }
});
