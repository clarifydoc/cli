import { describe, it, expect } from "vitest";
import { finalizeApiTargets, splitUnknownBase } from "./api-targets.js";
import type { DataSourceInfo } from "../types/analysis.js";

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

  it("drops a loopback origin but leaves another host's URL alone", () => {
    expect(splitUnknownBase("http://localhost:5000/api/series")).toEqual({
      target: "/api/series",
      baseExpr: "http://localhost:5000",
    });
    expect(splitUnknownBase("https://api.github.com/repos")).toBeNull();
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
