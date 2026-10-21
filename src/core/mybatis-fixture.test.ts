import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * MyBatis mapper XML on `test-fixtures/sample-mybatis`, against the labels in
 * its README — written by hand from its source.
 */
describe("MyBatis mapper XML — sample-mybatis", () => {
  let out: string;
  let summary: ProjectAnalysis;
  const xml = "src/main/resources/mapper/PlayerMapper.xml";
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-mybatis-"));
    await analyze({ projectRoot: resolve(__dirname, "../../test-fixtures/sample-mybatis"), outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("reads each statement's tables and access", async () => {
    const { readFile } = await import("fs/promises");
    const file = JSON.parse(await readFile(join(out, `${xml}.json`), "utf-8"));
    expect(file.dataSources.map((d: { target: string; access?: string; line: number }) => `${d.line} ${d.target} ${d.access}`)).toEqual([
      "13 app_players read",
      "13 departments read",
      "20 app_players read",
      "27 app_players write",
      "31 app_players write",
      "40 app_players read",
    ]);
  });

  it("links each interface method to its statement, and nothing to an unbound one", () => {
    const links = summary.symbolLinks
      .filter((l) => l.targetFile === xml)
      .map((l) => `${l.sourceSymbol}:${l.sourceLine} -> ${l.targetSymbol}:${l.targetLine} ${l.confidence}`)
      .sort();
    expect(links).toEqual([
      "PlayerMapper.deactivate:15 -> deactivate:31 EXTRACTED",
      "PlayerMapper.findById:9 -> findById:13 EXTRACTED",
      "PlayerMapper.insert:13 -> insert:27 EXTRACTED",
      "PlayerMapper.search:11 -> search:20 EXTRACTED",
    ]);
  });
});
