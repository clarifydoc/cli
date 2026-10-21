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
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", dependencies: { pg: "8.11.0", express: "4.19.2" } }));
    await writeFile(join(root, "src", "cars.ts"), [
      'import { Pool } from "pg";',                                            // 1
      'import { readFileSync } from "fs";',                                     // 2
      "const pool = new Pool();",                                               // 3
      "export async function loadParts(id: string) {",                          // 4
      '  return pool.query("SELECT * FROM car_parts WHERE car_id = $1", [id]);', // 5
      "}",                                                                      // 6
      "export async function report(ids: string[]) {",                          // 7
      '  for (const row of await pool.query("SELECT id FROM cars")) {',         // 8: the header runs once
      '    await pool.query("SELECT * FROM drivers WHERE id = $1", [row.id]);',   // 9: N+1, direct
      "  }",                                                                    // 10
      "  for (const id of ids) {",                                              // 11
      "    await loadParts(id);",                                               // 12: N+1, through a helper
      "  }",                                                                    // 13
      '  const tpl = readFileSync("tpl.html", "utf8");',                         // 14: blocks the loop
      "  return tpl;",                                                          // 15
      "}",                                                                      // 16
      "export function sync() {",                                               // 17
      '  return readFileSync("x", "utf8");',                                     // 18: not async: fine
      "}",                                                                      // 19
    ].join("\n"));
    await writeFile(join(root, "schema.sql"), [
      "CREATE TABLE drivers (id INT PRIMARY KEY, name TEXT);",
      "CREATE TABLE cars (id INT PRIMARY KEY, driver_id INT REFERENCES drivers(id));",
      "CREATE TABLE car_parts (id INT PRIMARY KEY, car_id INT);",
    ].join("\n"));
    await writeFile(join(root, "src", "server.ts"), [
      'import express from "express";',
      'import { report } from "./cars";',
      "const app = express();",
      "export async function handleReport(req: any, res: any) {",
      "  res.send(await report(req.query.ids));",
      "}",
      'app.get("/report", handleReport);',
      "app.listen(3000);",
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

  it("says what the loop walks, and the relation that would load it in one query", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const direct = (s.patterns ?? []).find((p) => p.kind === "query-in-loop" && p.line === 9)!;
    expect(direct.loop).toMatchObject({ iterates: "cars" });
    expect(direct.loop?.relation).toMatch(/^cars→drivers/);
    expect(direct.detail).toContain("once for each cars row the loop at line 8 walks — the cars→drivers");
    // A loop over a parameter says nothing about its size.
    expect((s.patterns ?? []).find((p) => p.kind === "query-in-loop" && p.line === 12)!.loop).toBeUndefined();
  });

  it("names the route that pays for each, so a request's N+1 ranks above code nothing reaches", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const perf = (s.patterns ?? []).filter((p) => p.kind === "query-in-loop" || p.kind === "blocking-in-async");
    expect(perf.length).toBe(3);
    for (const p of perf) {
      expect(p.role).toBe("request");
      expect(p.entries?.[0]).toMatchObject({ kind: "route", entry: "GET /report", file: "src/server.ts" });
    }
  });
});

describe("how big a loop is", () => {
  it("reads what a loop walks: a query's rows, or a few fixed passes", async () => {
    const { loopSize } = await import("./query-in-loop.js");
    const lines = [
      "def report(db):",                                  // 1
      "    cars = db.query(Car).all()",                   // 2
      "    for car in cars:",                             // 3
      "        pass",                                     // 4
    ];
    const queries = new Map([[2, "Car"], [7, "Bill"]]);
    expect(loopSize("for car in cars:", 3, 1, queries, lines)).toEqual({ iterates: "Car" });
    expect(loopSize("for (const bill of await db.bills.findMany())", 7, 1, queries, lines)).toEqual({ iterates: "Bill" });
    expect(loopSize('for (const status of ["open", "closed"])', 3, 1, undefined, lines)).toEqual({ bound: 2 });
    expect(loopSize("for i in range(3):", 3, 1, undefined, lines)).toEqual({ bound: 3 });
    expect(loopSize("for (let i = 0; i < 5; i++)", 3, 1, undefined, lines)).toEqual({ bound: 5 });
    expect(loopSize("for i in 0..3", 3, 1, undefined, lines)).toEqual({ bound: 3 });
    // Nothing the header says: neither a query's rows nor a small bound.
    expect(loopSize("for (const id of ids)", 3, 1, queries, lines)).toEqual({});
    expect(loopSize("for (let i = 0; i < 500; i++)", 3, 1, undefined, lines)).toEqual({});
  });
});
