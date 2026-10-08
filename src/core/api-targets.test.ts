import { describe, it, expect } from "vitest";
import { expandRequestFactories, finalizeApiTargets, splitUnknownBase } from "./api-targets.js";
import type { DataSourceInfo, FileAnalysis, FunctionInfo, PathArgCall } from "../types/analysis.js";
import type { ImportIndex } from "../types/project.js";

describe("splitUnknownBase", () => {
  it("splits a leading hole off, at the segment boundary it implies", () => {
    expect(splitUnknownBase("${this.baseUrl}email/all")).toEqual({ target: "/email/all", baseExpr: "this.baseUrl" });
    expect(splitUnknownBase("${environment.apiBaseUrl}statistics/")).toEqual({
      target: "/statistics/",
      baseExpr: "environment.apiBaseUrl",
    });
    expect(splitUnknownBase("${this.itemRoute(itemId)}/duplicate")).toEqual({
      target: "/duplicate",
      baseExpr: "this.itemRoute(itemId)",
    });
  });

  it("consumes every leading hole, braces balanced", () => {
    expect(splitUnknownBase("${this.baseUrl}${this.endpoint}/totp/")).toEqual({
      target: "/totp/",
      baseExpr: "this.baseUrl + this.endpoint",
    });
    expect(splitUnknownBase("{}{}/bulk_delete/")).toEqual({ target: "/bulk_delete/", baseExpr: "" });
    expect(splitUnknownBase("${fn({ a: 1 })}/x")).toEqual({ target: "/x", baseExpr: "fn({ a: 1 })" });
  });

  it("drops a loopback origin — a server on this machine, named by its port — but leaves another host's URL alone", () => {
    expect(splitUnknownBase("http://localhost:5000/api/series")).toEqual({ target: "/api/series", origin: "http://localhost:5000" });
    expect(splitUnknownBase("https://api.github.com/repos")).toBeNull();
  });

  it("reads a host left as a hole as an unknown base, never as this machine", () => {
    expect(splitUnknownBase("http://${IP}:5000/api/series")).toEqual({ target: "/api/series", baseExpr: "http://${IP}:5000" });
    expect(splitUnknownBase("http://${host}/api/${path}")).toEqual({ target: "/api/${path}", baseExpr: "http://${host}" });
  });

  it("reads a bare relative path as relative to an unknown base", () => {
    expect(splitUnknownBase("me")).toEqual({ target: "/me", baseExpr: "" });
    expect(splitUnknownBase("api/v1/accounts.json")).toEqual({ target: "/api/v1/accounts.json", baseExpr: "" });
  });

  it("leaves an app path, a lone hole and a query-only URL as written", () => {
    expect(splitUnknownBase("/api/x")).toBeNull();
    expect(splitUnknownBase("${this.url}")).toBeNull();
    expect(splitUnknownBase("${this.url}?filter_type=1")).toBeNull();
  });
});

describe("finalizeApiTargets", () => {
  it("rewrites api-call rows only", () => {
    const rows = [
      { kind: "api-call", name: "get", target: "${this.baseUrl}series/${id}", line: 1, calls: [], filePath: "a.ts" },
      { kind: "env", name: "X", target: "${y}z", line: 2, calls: [], filePath: "a.ts" },
    ] as (DataSourceInfo & { filePath: string })[];
    expect(finalizeApiTargets(rows)).toBe(1);
    expect(rows[0]).toMatchObject({ target: "/series/${id}", baseExpr: "this.baseUrl" });
    expect(rows[1]!.target).toBe("${y}z");
  });
});

describe("expandRequestFactories", () => {
  const fn = (name: string, line: number, endLine: number, params: string[]) =>
    ({ name, line, endLine, params: params.map((p) => ({ name: p, type: null, defaultValue: null })), calls: [] }) as unknown as FunctionInfo;
  const analysis = (filePath: string, functions: FunctionInfo[], pathArgCalls: PathArgCall[] = []) =>
    ({ filePath, functions, classes: [], exports: [], pathArgCalls }) as unknown as FileAnalysis;
  const factoryFile = analysis("Store/Creators/createFetchHandler.js", [
    fn("createFetchHandler", 5, 40, ["section", "url"]),
    fn("handler", 6, 39, ["getState", "payload", "dispatch"]),
  ]);
  const factoryRow = () => ({
    kind: "api-call" as const,
    name: "request",
    target: "${url}",
    targetAlternatives: ["${url}/${id}"],
    line: 14,
    calls: [],
    filePath: "Store/Creators/createFetchHandler.js",
  });
  const index = (imports: Record<string, string>): ImportIndex => ({
    localFor: (_f, n) => imports[n] ?? null,
    sourceFor: () => null,
    namespacesFor: () => [],
  });

  it("fills the factory's URL parameter from each call site's literal (Radarr)", () => {
    const calls: Array<DataSourceInfo & { filePath: string }> = [factoryRow()];
    const site = analysis("Store/Actions/systemActions.js", [], [
      { callee: "createFetchHandler", args: ["system.status", "/system/status"], line: 256 },
      { callee: "createFetchHandler", args: ["system.health", "/health"], line: 260 },
    ]);
    const added = expandRequestFactories(calls, [factoryFile, site], index({ createFetchHandler: factoryFile.filePath }));
    expect(added).toBe(2);
    expect(calls[1]).toMatchObject({
      filePath: "Store/Actions/systemActions.js",
      line: 256,
      target: "/system/status",
      targetAlternatives: ["/system/status/${id}"],
      via: "createFetchHandler",
    });
    expect(calls[2]!.target).toBe("/health");
  });

  it("follows a default export imported under another name", () => {
    const calls: Array<DataSourceInfo & { filePath: string }> = [factoryRow()];
    const exporting = { ...factoryFile, exports: [{ name: "default", kind: "default", line: 5 }] } as unknown as FileAnalysis;
    const site = analysis("a.js", [], [{ callee: "fetchIt", args: ["x", "/y"], line: 3 }]);
    expect(expandRequestFactories(calls, [exporting, site], index({ fetchIt: factoryFile.filePath }))).toBe(1);
    expect(calls[1]!.target).toBe("/y");
  });

  it("falls back to the one factory of that name when the import does not resolve", () => {
    const calls: Array<DataSourceInfo & { filePath: string }> = [factoryRow()];
    const site = analysis("Store/Actions/Settings/tags.js", [], [{ callee: "createFetchHandler", args: ["tags", "/tag"], line: 9 }]);
    expect(expandRequestFactories(calls, [factoryFile, site], index({}))).toBe(1);
    expect(calls[1]!.target).toBe("/tag");
  });

  it("adds nothing when the argument is not a literal or the callee is unknown", () => {
    const calls: Array<DataSourceInfo & { filePath: string }> = [factoryRow()];
    const site = analysis("a.js", [], [
      { callee: "createFetchHandler", args: ["x", null], line: 1 },
      { callee: "somethingElse", args: ["x", "/y"], line: 2 },
    ]);
    expect(expandRequestFactories(calls, [factoryFile, site], index({ createFetchHandler: factoryFile.filePath }))).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("does not treat a hole that is the inner function's own parameter as the factory's", () => {
    const row = { ...factoryRow(), target: "/items/${payload}", targetAlternatives: undefined };
    const calls: Array<DataSourceInfo & { filePath: string }> = [row];
    const site = analysis("a.js", [], [{ callee: "createFetchHandler", args: ["x", "/y", "/z"], line: 1 }]);
    expect(expandRequestFactories(calls, [factoryFile, site], index({ createFetchHandler: factoryFile.filePath }))).toBe(0);
  });
});
