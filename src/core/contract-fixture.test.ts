import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Request contracts on `test-fixtures/sample-contract-mismatch`, against the
 * labels in its README — written by hand from its source: a NestJS API whose
 * DTOs disagree with what the web client sends.
 */
describe("request and response contracts — sample-contract-mismatch", () => {
  let out: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-contracts-"));
    await analyze({ projectRoot: resolve(__dirname, "../../test-fixtures/sample-contract-mismatch"), outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("finds exactly the labelled disagreements", () => {
    const found = (summary.contractFindings ?? []).map((f) => `${f.method} ${f.url} ${f.kind} ${f.field}${f.expected ? ` ${f.expected}←${f.actual}` : ""}`).sort();
    expect(found).toEqual([
      "GET /players/${id} unknown-response-field mail",
      "GET /stats unknown-response-field totals",
      "POST /players missing-field age",
      "POST /players unknown-field nickname",
      "PUT /players/${id} type-mismatch age number←string",
    ]);
  });

  it("knows what each route answers", () => {
    const row = (path: string, method: string) => summary.routeMap.find((r) => r.path === path && r.httpMethod === method);
    expect(row("/players/:id", "GET")?.responseSchema).toMatchObject({ type: "object", properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } } });
    expect(row("/stats", "GET")?.responseSchema).toEqual({ type: "object", properties: { active: {}, total: {} }, additionalProperties: false });
    expect(row("/players", "POST")?.responses).toEqual([{ status: 201 }]);
  });
});
