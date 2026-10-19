import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

describe("performance patterns, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-perf-"));
    const root = join(dir, "app");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", dependencies: { pg: "8.11.0" } }));
    await writeFile(join(root, "src", "orders.ts"), [
      'import { Pool } from "pg";',                                            // 1
      'import { readFileSync } from "fs";',                                     // 2
      "const pool = new Pool();",                                               // 3
      "export async function loadItems(id: string) {",                          // 4
      '  return pool.query("SELECT * FROM items WHERE order_id = $1", [id]);',  // 5
      "}",                                                                      // 6
      "export async function report(ids: string[]) {",                          // 7
      '  for (const row of await pool.query("SELECT id FROM orders")) {',       // 8: the header runs once
      '    await pool.query("SELECT * FROM customers WHERE id = $1", [row.id]);', // 9: N+1, direct
      "  }",                                                                    // 10
      "  for (const id of ids) {",                                              // 11
      "    await loadItems(id);",                                               // 12: N+1, through a helper
      "  }",                                                                    // 13
      '  const tpl = readFileSync("tpl.html", "utf8");',                         // 14: blocks the loop
      "  return tpl;",                                                          // 15
      "}",                                                                      // 16
      "export function sync() {",                                               // 17
      '  return readFileSync("x", "utf8");',                                     // 18: not async: fine
      "}",                                                                      // 19
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the query per loop pass — direct and through a helper — and the blocking call in async code", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const got = (s.patterns ?? []).filter((p) => p.kind === "query-in-loop" || p.kind === "blocking-in-async").map((p) => `${p.kind} ${p.name}:${p.line} ${p.confidence}`).sort();
    expect(got).toEqual(["blocking-in-async report:14 medium", "query-in-loop report:12 medium", "query-in-loop report:9 high"].sort());
  });
});
