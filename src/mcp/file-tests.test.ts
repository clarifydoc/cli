/**
 * clarifydoc_file's tests section: the tests a file declares, the test files
 * depending on it, for each of its functions the nearest test reaching it with
 * the chain of calls, and — for a test file — what its tests call.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../core/analyzer.js";
import { buildMcpServer } from "./server.js";

let dir = "";
const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-table", devDependencies: { vitest: "^2.0.0" } }),
  "src/table.ts": [
    "export function sortClubs(points: number[]): number[] { return [...points].sort(); }",
    "export function buildTable(points: number[]): string[] { return sortClubs(points).map(String); }",
    "export function relegate(points: number[]): number[] { return points.slice(0, -3); }",
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
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-file-tests-"));
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
  return res.result.content[0]!.text;
}

describe("clarifydoc_file tests section", () => {
  it("names, for a source file, the test files depending on it and the test reaching each function with its call chain", async () => {
    const text = await fileTests("src/table.ts");
    expect(text).toContain("## Tests");
    expect(text).toContain("test/table.test.ts — depends on it (component graph)");
    expect(text).toContain("2 of 3 reached through the call graph");
    expect(text).toContain("none reaches relegate");
    expect(text).toContain("buildTable() line 2 ← league › builds test/table.test.ts:5 — calls it");
    expect(text).toContain("sortClubs() line 1 ← league › builds test/table.test.ts:5 — 2 calls: league › builds → buildTable → sortClubs");
  });

  it("names, for a test file, the tests it declares and what they call", async () => {
    const text = await fileTests("test/table.test.ts");
    expect(text).toContain("declares 2 test functions (cases: 1, suites: 1)");
    expect(text).toContain("- league › builds [case] (line 4)");
    expect(text).toContain("buildTable() src/table.ts:2 ← league › builds (line 5)");
  });
});
