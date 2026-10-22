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

describe("attributeDataAccessToSymbols — inline route handlers", () => {
  it("gives an access inside an inline handler to its route, not to the method registering it", () => {
    const api = {
      filePath: "src/LeagueApi.cs",
      language: "csharp",
      functions: [],
      classes: [{ name: "LeagueApi", line: 1, endLine: 20, methods: [{ name: "MapLeagueApi", line: 3, endLine: 10, params: [], calls: [] }] }],
      routes: [
        { path: "/api/kits", httpMethod: "GET", kind: "api", handler: null, middleware: [], line: 5, calls: [{ name: "context.Kits.ToListAsync", kind: "internal", target: null, line: 5 }] },
        { path: "/api/badges", httpMethod: "GET", kind: "api", handler: null, middleware: [], line: 6, calls: [{ name: "context.Badges.ToListAsync", kind: "internal", target: null, line: 6 }] },
      ],
      dataSources: [
        row({ name: "EF: ToListAsync", target: "Kit", entity: "Kit", access: "read", line: 5 }),
        row({ name: "EF: ToListAsync", target: "Badge", entity: "Badge", access: "read", line: 6 }),
        row({ name: "EF: SaveChanges", target: "Club", entity: "Club", access: "write", line: 8 }),
      ],
    } as unknown as FileAnalysis;
    const rows = attributeDataAccessToSymbols([api], { nodes: [], edges: [] } as never);
    expect(rows.map((r) => `${r.symbol} ${r.entity}`)).toEqual([
      "LeagueApi.MapLeagueApi Club",
      "route:GET /api/badges Badge",
      "route:GET /api/kits Kit",
    ]);
  });
});
