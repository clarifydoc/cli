import { describe, it, expect } from "vitest";
import { buildSarif } from "./sarif.js";
import type { SecurityIssue } from "../types/analysis.js";

const issue = (over: Partial<SecurityIssue>): SecurityIssue => ({
  category: "sql-injection", severity: "high", message: "SQL built from values.", filePath: "src/repo.ts", line: 42,
  snippet: 'db.query("SELECT … " + id)', cwe: "CWE-89", ...over,
});

describe("buildSarif", () => {
  it("writes one rule per category with its CWE tags and one located result per finding", () => {
    const log = buildSarif([
      issue({}),
      issue({ line: 50 }),
      issue({ category: "insecure-config", severity: "medium", cwe: "CWE-295", message: "TLS off.", filePath: "src/http.ts", line: 3, snippet: "rejectUnauthorized: false" }),
      issue({ category: "todo-fixme", severity: "low", cwe: undefined, message: "TODO", snippet: "// TODO" }),
    ], "0.7.0");
    const run = log.runs[0]!;
    expect(log.version).toBe("2.1.0");
    expect(run.tool.driver.rules.map((r) => [r.id, r.defaultConfiguration.level, r.properties.tags])).toEqual([
      ["clarifydoc/insecure-config", "warning", ["security", "external/cwe/cwe-295"]],
      ["clarifydoc/sql-injection", "error", ["security", "external/cwe/cwe-89"]],
    ]);
    // TODO notes are not findings.
    expect(run.results).toHaveLength(3);
    expect(run.results[0]).toMatchObject({
      ruleId: "clarifydoc/sql-injection",
      ruleIndex: 1,
      level: "error",
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/repo.ts", uriBaseId: "%SRCROOT%" }, region: { startLine: 42 } } }],
    });
    // The same line twice is two findings with distinct fingerprints; moving a line keeps its fingerprint.
    const fp = run.results.map((r) => r.partialFingerprints["clarifydocFinding/v1"]);
    expect(new Set(fp).size).toBe(3);
    const moved = buildSarif([issue({ line: 99 })], "0.7.0").runs[0]!.results[0]!.partialFingerprints;
    expect(moved["clarifydocFinding/v1"]).toBe(fp[0]);
  });
});

describe("buildSarif — structural findings", () => {
  it("adds calls that reach no route and forbidden imports as their own rules", async () => {
    const { structuralFindings, resultsAtLeast } = await import("./sarif.js");
    const extra = structuralFindings({
      apiRouteLinkStats: {
        misses: [
          { file: "web/a.ts", line: 3, method: "DELETE", url: "/api/orders", reason: "method-mismatch", existing: [{ method: "GET", path: "/api/orders", file: "api/o.py", line: 9 }] },
          { file: "web/b.ts", line: 5, method: "GET", url: "/api/nope", reason: "unmatched" },
        ],
      } as never,
      layerViolations: [{ sourceFile: "src/ui/x.ts", sourceLayer: "ui", targetFile: "src/db/y.ts", targetLayer: "data", importSpecifier: "../db/y", line: 2, rule: "ui-no-db", severity: "error" }] as never,
    });
    const log = buildSarif([], "1.0.0", extra);
    const run = log.runs[0]!;
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(["clarifydoc/route-method-mismatch", "clarifydoc/route-unmatched", "clarifydoc/import-rule"]);
    expect(run.results.map((r) => [r.ruleId, r.level])).toEqual([
      ["clarifydoc/route-method-mismatch", "error"],
      ["clarifydoc/route-unmatched", "warning"],
      ["clarifydoc/import-rule", "error"],
    ]);
    expect(run.results[0]!.message.text).toContain("served as GET /api/orders (api/o.py:9)");
    expect(resultsAtLeast(log, "error")).toBe(2);
    expect(resultsAtLeast(log, "warning")).toBe(3);
  });
});
