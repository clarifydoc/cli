import { describe, it, expect } from "vitest";
import { attachFindingEntries } from "./finding-entries.js";
import type { FileAnalysis, SecurityIssue, SymbolLink } from "../types/analysis.js";

const fns = (filePath: string, ...defs: Array<[string, number, number]>): FileAnalysis =>
  ({ filePath, functions: defs.map(([name, line, endLine]) => ({ name, line, endLine })), classes: [] }) as unknown as FileAnalysis;
const link = (sf: string, ss: string, tf: string, ts: string, confidence: SymbolLink["confidence"] = "EXTRACTED"): SymbolLink => ({
  sourceFile: sf, sourceSymbol: ss, sourceLine: 1, callName: ts, targetFile: tf, targetSymbol: ts, targetLine: 1, confidence,
});
const sqli = (filePath: string, line: number): SecurityIssue => ({
  category: "sql-injection", severity: "high", message: "SQL built from values.", filePath, line, snippet: "db.query(…)",
});

describe("attachFindingEntries", () => {
  it("names the routes whose handlers reach the function a sink finding sits in", () => {
    const issues = [sqli("repo.ts", 12), { ...sqli("repo.ts", 30), category: "hardcoded-secret" as const }];
    const routes = {
      ...fns("routes.ts"),
      routes: [
        { path: "/search", httpMethod: "POST", kind: "api", handler: "SearchController.run", line: 1, calls: [], middleware: [] },
      ],
    } as unknown as FileAnalysis;
    const n = attachFindingEntries(issues, [fns("repo.ts", ["search", 10, 20], ["other", 28, 40]), routes], [
      link("routes.ts", "route:POST /search", "ctl.ts", "SearchController.run"),
      link("ctl.ts", "SearchController.run", "repo.ts", "search", "INFERRED"),
      link("admin.ts", "route:GET /admin/find", "repo.ts", "search", "AMBIGUOUS"),
    ]);
    expect(n).toBe(1);
    // Over resolved links only: the guessed admin edge is not grounds.
    expect(issues[0]!.entries).toEqual([{ route: "POST /search", file: "routes.ts", distance: 2, confidence: "INFERRED" }]);
    // Only input sinks are traced.
    expect(issues[1]!.entries).toBeUndefined();
  });
});

describe("anonymousWriteFindings", () => {
  const route = (method: string, path: string, anonymous: boolean | undefined) =>
    ({ path, httpMethod: method, kind: "api", handler: "h", line: 5, calls: [], middleware: [], filePath: "Ctl.cs",
       ...(anonymous === undefined ? {} : { auth: { policies: [], roles: [], schemes: [], anonymous } }) }) as never;
  const flow = (label: string, effect: string) =>
    ({ entryKind: "route", entryLabel: label, entryFile: "Ctl.cs", effect, resource: "Orders", distance: 2, confidence: "INFERRED" }) as never;

  it("flags an anonymous mutating route that writes, and nothing else", async () => {
    const { anonymousWriteFindings } = await import("./finding-entries.js");
    const found = anonymousWriteFindings(
      [route("POST", "/orders", true), route("GET", "/orders", true), route("DELETE", "/orders/{id}", false), route("PUT", "/orders/{id}", undefined)],
      [flow("POST /orders", "db-write"), flow("GET /orders", "db-read"), flow("DELETE /orders/{id}", "db-write"), flow("PUT /orders/{id}", "db-write")],
    );
    expect(found.map((f) => [f.category, f.snippet, f.cwe])).toEqual([["missing-auth", "POST /orders → h", "CWE-306"]]);
  });
});
