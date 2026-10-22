import { describe, it, expect } from "vitest";
import { attributeDataAccessToSymbols } from "./data-access-graph.js";
import type { DataSourceInfo, FileAnalysis } from "../types/analysis.js";

const row = (extra: Partial<DataSourceInfo>): DataSourceInfo => ({ kind: "database", name: "x", target: null, calls: [], line: 4, ...extra });

const file = (dataSources: DataSourceInfo[]) => ({
  filePath: "src/SquadStore.cs",
  language: "csharp",
  functions: [],
  classes: [{ name: "SquadStore", line: 1, endLine: 10, methods: [{ name: "Save", line: 3, endLine: 6, params: [], calls: [] }] }],
  dataSources,
}) as unknown as FileAnalysis;

describe("attributeDataAccessToSymbols", () => {
  it("reaches a store with no tables by name, and drops a database row naming nothing", () => {
    const rows = attributeDataAccessToSymbols([file([
      row({ name: "Redis: StringSetAsync", target: "redis", store: true, access: "write" }),
      row({ name: "ADO.NET: ExecuteNonQuery", target: "league", access: "write" }),
    ])], { nodes: [], edges: [] } as never);
    expect(rows.map((r) => `${r.symbol} ${r.entity} ${r.datastore}`)).toEqual(["SquadStore.Save redis redis"]);
  });
});
