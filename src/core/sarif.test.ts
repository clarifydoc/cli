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
          { file: "web/a.ts", line: 3, method: "DELETE", url: "/api/cars", reason: "method-mismatch", existing: [{ method: "GET", path: "/api/cars", file: "api/o.py", line: 9 }] },
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
    expect(run.results[0]!.message.text).toContain("served as GET /api/cars (api/o.py:9)");
    expect(resultsAtLeast(log, "error")).toBe(2);
    expect(resultsAtLeast(log, "warning")).toBe(3);
  });
});

describe("CI gates, baseline and other report formats", () => {
  const structural = async () => {
    const { structuralFindings } = await import("./sarif.js");
    return structuralFindings({
      patterns: [
        { kind: "query-in-loop", name: "list", filePath: "src/cars.ts", line: 12, confidence: "high", detail: "queries Car once per pass of the loop at line 10", role: "request",
          entries: [{ kind: "route", entry: "GET /cars", file: "src/routes.ts", distance: 1, confidence: "EXTRACTED" }] },
        { kind: "blocking-in-async", name: "rebuild", filePath: "src/cli.ts", line: 4, confidence: "medium", detail: "readFileSync() blocks" },
        { kind: "singleton", name: "Db", filePath: "src/db.ts", line: 1, confidence: "high", detail: "" },
      ],
      deadCode: {
        languages: ["typescript"], judgedFiles: 3, entryFiles: 1,
        files: [
          { filePath: "src/old.ts", confidence: "INFERRED", deadImporters: 0 },
          { filePath: "src/maybe.ts", confidence: "AMBIGUOUS", deadImporters: 0 },
        ],
        exports: [{ filePath: "src/util.ts", name: "pad", kind: "function", line: 8, usedInFile: false }],
      },
    });
  };

  it("reports performance (a warning where a request pays) and dead code (notes, sure files only)", async () => {
    const found = await structural();
    expect(found.map((f) => [f.ruleId, f.level, f.file])).toEqual([
      ["clarifydoc/query-in-loop", "warning", "src/cars.ts"],
      ["clarifydoc/blocking-in-async", "note", "src/cli.ts"],
      ["clarifydoc/unreachable-file", "note", "src/old.ts"],
      ["clarifydoc/unused-export", "note", "src/util.ts"],
    ]);
    expect(found[0]!.message).toContain("Reached from GET /cars");
  });

  it("gates on a level, on categories, or both", async () => {
    const { parseFailOn, failingResults, isKnownCategory, STRUCTURAL_RULE_IDS } = await import("./sarif.js");
    const log = buildSarif([issue({})], "0.7.0", await structural());
    const count = (v: string) => failingResults(log, parseFailOn(v)).map((r) => r.ruleId);
    expect(count("error")).toEqual(["clarifydoc/sql-injection"]);
    expect(count("warning")).toEqual(["clarifydoc/sql-injection", "clarifydoc/query-in-loop"]);
    expect(count("performance")).toEqual(["clarifydoc/query-in-loop", "clarifydoc/blocking-in-async"]);
    expect(count("performance,warning")).toEqual(["clarifydoc/query-in-loop"]);
    expect(count("dead-code")).toEqual(["clarifydoc/unreachable-file", "clarifydoc/unused-export"]);
    expect(count("clarifydoc/sql-injection")).toEqual(["clarifydoc/sql-injection"]);
    expect(() => parseFailOn("error,warning")).toThrow(/one level/);
    expect(isKnownCategory("route-miss", STRUCTURAL_RULE_IDS)).toBe(true);
    expect(isKnownCategory("route-method-mismatch", STRUCTURAL_RULE_IDS)).toBe(true);
    expect(isKnownCategory("secruity", STRUCTURAL_RULE_IDS)).toBe(false);
  });

  it("counts only what the base did not have, by fingerprint, even when lines moved", async () => {
    const { applyBaseline, failingResults } = await import("./sarif.js");
    const base = buildSarif([issue({})], "0.7.0");
    const head = buildSarif([issue({ line: 80 }), issue({ category: "xss", cwe: "CWE-79", snippet: "el.innerHTML = q", line: 5 })], "0.7.0");
    expect(applyBaseline(head, base)).toBe(1);
    expect(head.runs[0]!.results.map((r) => r.baselineState)).toEqual(["unchanged", "new"]);
    expect(failingResults(head, { level: "error" }).map((r) => r.ruleId)).toEqual(["clarifydoc/xss"]);
  });

  it("writes JUnit (a failing case per rule the gate counts) and GitLab Code Quality", async () => {
    const { sarifToJunit, sarifToCodeQuality } = await import("./sarif.js");
    const log = buildSarif([issue({ message: "SQL <built> & sent" })], "0.7.0", await structural());
    const junit = sarifToJunit(log, { level: "warning" });
    expect(junit).toContain('<testsuite name="ClarifyDoc" tests="5" failures="2" errors="0">');
    expect(junit).toContain("src/repo.ts:42 SQL &lt;built&gt; &amp; sent (CWE-89)");
    const cq = JSON.parse(sarifToCodeQuality(log));
    expect(cq[0]).toMatchObject({ check_name: "clarifydoc/sql-injection", severity: "major", categories: ["Security"], location: { path: "src/repo.ts", lines: { begin: 42 } } });
    expect(new Set(cq.map((x: { fingerprint: string }) => x.fingerprint)).size).toBe(cq.length);
  });
});
