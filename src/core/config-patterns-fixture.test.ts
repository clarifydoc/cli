import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { loadProjectConfig } from "./project-config.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const root = resolve(__dirname, "../../test-fixtures/sample-config-patterns");

/** Config-declared extraction on `test-fixtures/sample-config-patterns`, against the labels in its README. */
describe("config extract patterns — sample-config-patterns", () => {
  let out: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-cfgpat-"));
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("turns the wrappers' call sites into routes, links and data access", () => {
    expect(summary.routeMap.map((r) => `${r.httpMethod} ${r.path} ${r.filePath}:${r.line}`).sort()).toEqual([
      "GET /api/cars server/cars.ts:14",
      "POST /api/cars server/cars.ts:15",
    ]);
    expect((summary.apiRouteLinks ?? []).map((l) => `${l.method} ${l.source}:${l.sourceLine} -> ${l.target}:${l.targetLine}`).sort()).toEqual([
      "GET web/cars-page.ts:4 -> server/cars.ts:14",
      "POST web/cars-page.ts:8 -> server/cars.ts:15",
    ]);
  });

  it("records the database access only the config names", () => {
    const tables = (summary.entityGraph?.nodes ?? []).map((n) => n.name).sort();
    expect(tables).toContain("payments");
    expect(tables).toContain("cars");
    expect(tables.filter((t) => t === "cars")).toHaveLength(1);
  });

  it("reads the config strictly enough to say what it dropped", () => {
    const { config, warnings } = loadProjectConfig(root);
    expect(config.extract?.db?.map((d) => d.call)).toEqual(["db.exec", "ledger.write"]);
    expect(warnings).toEqual([]);
  });
});
