import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Flyway chain replayed into one schema on `test-fixtures/sample-flyway`,
 * against the labels in its README — written by hand from its source.
 */
describe("migration replay — sample-flyway", () => {
  let out: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-flyway-"));
    await analyze({ projectRoot: resolve(__dirname, "../../test-fixtures/sample-flyway"), outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("ends with the labelled tables, columns and declarations", () => {
    const rows = summary.entityGraph!.nodes.map((n) => `${n.name} ${n.filePath.split("/").pop()}:${n.line} ${n.columns.map((c) => c.name).join(",")}`).sort();
    expect(rows).toEqual([
      "audit V5__audit_v2.sql:3 id,actor_id,action",
      "cars V1__init.sql:6 id,player_id,placed_at",
      "players V1__init.sql:1 id,display_name,email",
    ]);
  });

  it("keeps the foreign keys the final schema holds", () => {
    const name = new Map(summary.entityGraph!.nodes.map((n) => [n.id, n.name]));
    const edges = summary.entityGraph!.edges.map((e) => [name.get(e.source), name.get(e.target)].sort().join("–") + ` ${e.foreignKey}`).sort();
    expect(edges).toEqual(["audit–players actor_id", "cars–players player_id"]);
  });
});
