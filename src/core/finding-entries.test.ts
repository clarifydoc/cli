import { describe, it, expect } from "vitest";
import { attachFindingEntries, attachPatternEntries } from "./finding-entries.js";
import type { FileAnalysis, PatternInfo, SecurityIssue, SymbolLink } from "../types/analysis.js";

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

describe("attachPatternEntries", () => {
  const loop = (filePath: string, line: number, name: string): PatternInfo => ({
    kind: "query-in-loop", name, filePath, line, confidence: "high", detail: "queries Order once per pass",
  });

  it("says which routes and commands pay for a performance pattern, and ranks a request first", () => {
    const routes = {
      ...fns("routes.ts", ["list", 3, 9]),
      routes: [{ path: "/orders", httpMethod: "GET", kind: "api", handler: "list", line: 3, calls: [], middleware: [] }],
    } as unknown as FileAnalysis;
    const patterns = [
      loop("repo.ts", 12, "loadAll"),
      loop("repo.ts", 32, "rebuild"),
      loop("repo.ts", 52, "orphan"),
      { kind: "god-object", name: "Repo", filePath: "repo.ts", line: 12, confidence: "low", detail: "" } as PatternInfo,
    ];
    const n = attachPatternEntries(
      patterns,
      [fns("repo.ts", ["loadAll", 10, 20], ["rebuild", 30, 40], ["orphan", 50, 60]), routes, fns("cli.ts", ["reindex", 1, 9])],
      [
        link("routes.ts", "route:GET /orders", "routes.ts", "list"),
        link("routes.ts", "list", "repo.ts", "loadAll"),
        link("cli.ts", "reindex", "repo.ts", "rebuild"),
      ],
      [{ kind: "cli-command", name: "reindex", handler: "reindex", line: 2, filePath: "cli.ts" }],
    );
    expect(n).toBe(2);
    expect(patterns[0]!.role).toBe("request");
    expect(patterns[0]!.entries).toEqual([{ kind: "route", entry: "GET /orders", file: "routes.ts", distance: 2, confidence: "INFERRED" }]);
    expect(patterns[1]!.role).toBe("command");
    expect(patterns[1]!.entries).toEqual([{ kind: "cli-command", entry: "reindex", file: "cli.ts", distance: 1, confidence: "EXTRACTED" }]);
    // Nothing reaches it: no entry, no role — not "unreached", which a missed link would also look like.
    expect(patterns[2]!.entries).toBeUndefined();
    expect(patterns[2]!.role).toBeUndefined();
    // Only performance patterns are traced.
    expect(patterns[3]!.entries).toBeUndefined();
  });

  it("calls a pattern a consumer or a scheduled job reaches background work", () => {
    const patterns = [loop("worker.ts", 5, "handle")];
    attachPatternEntries(patterns, [fns("worker.ts", ["handle", 1, 9])], [],
      [{ kind: "message-consumer", name: "emails", handler: "handle", line: 1, filePath: "worker.ts" }]);
    expect(patterns[0]!.role).toBe("background");
    expect(patterns[0]!.entries).toEqual([{ kind: "message-consumer", entry: "emails", file: "worker.ts", distance: 0, confidence: "EXTRACTED" }]);
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

describe("safeMethodWriteFindings", () => {
  const route = (method: string, path: string) =>
    ({ path, httpMethod: method, kind: "api", handler: "h", line: 5, calls: [], middleware: [], filePath: "Ctl.cs" }) as never;
  const flow = (label: string, effect: string, resource = "Orders") =>
    ({ entryKind: "route", entryLabel: label, entryFile: "Ctl.cs", effect, resource, distance: 2, confidence: "INFERRED" }) as never;

  it("flags a GET or HEAD that writes, naming the tables, and no other method", async () => {
    const { safeMethodWriteFindings } = await import("./finding-entries.js");
    const found = safeMethodWriteFindings(
      [route("GET", "/orders/{id}/confirm"), route("GET", "/orders"), route("POST", "/orders"), route("HEAD", "/ping")],
      [flow("GET /orders/{id}/confirm", "db-write"), flow("GET /orders/{id}/confirm", "db-write", "AuditLog"), flow("GET /orders", "db-read"), flow("POST /orders", "db-write"), flow("HEAD /ping", "db-write", "Visits")],
    );
    expect(found.map((f) => [f.category, f.snippet, f.cwe])).toEqual([
      ["safe-method-write", "GET /orders/{id}/confirm → h", "CWE-650"],
      ["safe-method-write", "HEAD /ping → h", "CWE-650"],
    ]);
    expect(found[0]!.message).toContain("writes AuditLog, Orders");
  });
});
