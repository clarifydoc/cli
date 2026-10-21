import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { buildSarif } from "./sarif.js";
import { importSarif } from "./sarif-import.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const root = resolve(__dirname, "../../test-fixtures/sample-backend");

/** What Semgrep and CodeQL write, cut down to the fields that matter. */
const semgrep = {
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: "Semgrep OSS", rules: [{ id: "js.sqli.raw-query", properties: { tags: ["security", "CWE-89: SQL Injection"] }, defaultConfiguration: { level: "error" } }] } },
    results: [
      { ruleId: "js.sqli.raw-query", level: "error", message: { text: "Raw query built from a request parameter" }, locations: [{ physicalLocation: { artifactLocation: { uri: "services/playerService.ts" }, region: { startLine: 17 } } }] },
      { ruleId: "js.sqli.raw-query", message: { text: "In a dependency" }, locations: [{ physicalLocation: { artifactLocation: { uri: "../node_modules/x/index.js" }, region: { startLine: 1 } } }] },
    ],
  }],
};
const codeql = {
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: "CodeQL", rules: [{ id: "js/missing-rate-limiting", properties: { "security-severity": "9.1", tags: ["external/cwe/cwe-770"] } }] } },
    originalUriBaseIds: { SRCROOT: { uri: `file://${root}/` } },
    results: [{ ruleId: "js/missing-rate-limiting", message: { text: "This route handler performs a database access without rate limiting" }, locations: [{ physicalLocation: { artifactLocation: { uri: "routes/players.ts", uriBaseId: "SRCROOT" }, region: { startLine: 14 } } }] }],
  }],
};

describe("importSarif", () => {
  it("maps rules to categories and severities, and keeps only analyzed files", () => {
    const got = importSarif(JSON.stringify(semgrep), root, new Set(["services/playerService.ts"]));
    expect(got.tools).toEqual([{ tool: "Semgrep OSS", results: 2, matched: 1 }]);
    expect(got.issues).toEqual([expect.objectContaining({ category: "sql-injection", cwe: "CWE-89", severity: "high", filePath: "services/playerService.ts", line: 17, tool: "Semgrep OSS", ruleId: "js.sqli.raw-query" })]);
    const q = importSarif(JSON.stringify(codeql), root, new Set(["routes/players.ts"]));
    expect(q.issues).toEqual([expect.objectContaining({ category: "external", cwe: "CWE-770", severity: "critical", filePath: "routes/players.ts" })]);
    expect(() => importSarif("{}", root, new Set())).toThrow(/no `runs`/);
  });
});

describe("importSarif — code flows", () => {
  it("keeps a result's first thread flow as its steps, across files, inside the project only", () => {
    const log = { version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL", rules: [] } }, results: [{
      ruleId: "js/sql-injection",
      locations: [{ physicalLocation: { artifactLocation: { uri: "services/playerService.ts" }, region: { startLine: 17 } } }],
      codeFlows: [{ threadFlows: [{ locations: [
        { location: { physicalLocation: { artifactLocation: { uri: "routes/players.ts" }, region: { startLine: 9 } }, message: { text: "req.query.name" } } },
        { location: { physicalLocation: { artifactLocation: { uri: "../node_modules/x.js" }, region: { startLine: 1 } }, message: { text: "outside" } } },
        { location: { physicalLocation: { artifactLocation: { uri: "services/playerService.ts" }, region: { startLine: 17 } }, message: { text: "db.query(sql)" } } },
      ] }] }],
    }] }] };
    const [issue] = importSarif(JSON.stringify(log), root, new Set(["routes/players.ts", "services/playerService.ts"])).issues;
    expect(issue!.flow).toEqual([
      { line: 9, note: "req.query.name", file: "routes/players.ts" },
      { line: 17, note: "db.query(sql)" },
    ]);
    // …and writes them back out as SARIF code flows.
    const out = buildSarif([{ ...issue!, tool: undefined }], "test");
    expect(out.runs[0]!.results[0]!.codeFlows?.[0]?.threadFlows[0]?.locations.map((l) => `${l.location.physicalLocation.artifactLocation.uri}:${l.location.physicalLocation.region.startLine} ${l.location.message.text}`)).toEqual([
      "routes/players.ts:9 req.query.name",
      "services/playerService.ts:17 db.query(sql)",
    ]);
  });
});

describe("analyze --import-sarif — sample-backend", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "clarifydoc-sarif-in-"));
    writeFileSync(join(dir, "semgrep.sarif"), JSON.stringify(semgrep));
    writeFileSync(join(dir, "codeql.sarif"), JSON.stringify(codeql));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, importSarif: [join(dir, "semgrep.sarif"), join(dir, "codeql.sarif")] });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("says which routes reach another tool's finding, and keeps it out of its own SARIF and grade", () => {
    const sqli = summary.securityIssues!.find((i) => i.tool === "Semgrep OSS")!;
    expect(sqli.entries?.map((e) => e.route)).toContain("GET /api/players/:id");
    expect(summary.importedFindings).toEqual([
      { source: "semgrep.sarif", tool: "Semgrep OSS", results: 2, matched: 1 },
      { source: "codeql.sarif", tool: "CodeQL", results: 1, matched: 1 },
    ]);
    const ours = buildSarif(summary.securityIssues!, "test");
    expect(JSON.stringify(ours)).not.toContain("js.sqli.raw-query");
  });
});
