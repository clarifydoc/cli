import { describe, it, expect } from "vitest";
import { computeParamColumns } from "./param-columns.js";
import type { FileAnalysis, SymbolLink } from "../types/analysis.js";

const fn = (name: string, line: number, endLine: number, params: string[], calls: any[] = []): any =>
  ({ name, params: params.map((p) => ({ name: p, type: null, defaultValue: null })), returnType: null, isAsync: true, isExported: true, decorators: [], calls, line, endLine });
const file = (filePath: string, functions: any[], extra: Partial<FileAnalysis> = {}): FileAnalysis =>
  ({ filePath, language: "typescript", functions, classes: [], dataSources: [], routes: [], imports: [], exports: [], ...extra }) as unknown as FileAnalysis;
const link = (sourceFile: string, sourceSymbol: string, sourceLine: number, callName: string, targetFile: string, targetSymbol: string): SymbolLink =>
  ({ sourceFile, sourceSymbol, sourceLine, callName, targetFile, targetSymbol, targetLine: 1, confidence: "EXTRACTED", relation: "calls" }) as SymbolLink;

describe("paramColumns", () => {
  // GET /clubs/:slug reads the slug off the request and hands it to getClub, which hands it to findClub's filter.
  const route = {
    kind: "api", path: "/clubs/:slug", httpMethod: "GET", handler: null, line: 3, filePath: "api/routes/clubs.ts",
    params: [{ name: "slug", type: null, binding: "route", inferred: true }, { name: "season", type: null, binding: "query" }],
    calls: [{ name: "getClub", kind: "cross-file", target: "../services/clubs", line: 4, argOrigins: [{ index: 0, origin: { kind: "route-param", name: "slug" } }] }],
  } as any;
  const service = file("api/services/clubs.ts", [
    fn("getClub", 1, 4, ["slug"], [{ name: "findClub", kind: "internal", target: null, line: 2, argOrigins: [{ index: 0, origin: { kind: "param", name: "slug", index: 0 } }] }]),
    fn("findClub", 6, 9, ["clubSlug"]),
  ], {
    dataSources: [
      { kind: "database", name: "prisma.club.findUnique", target: null, entity: "club", access: "read", line: 7, calls: [], whereFields: [{ field: "slug", origin: { kind: "param", name: "clubSlug", index: 0 } }] },
      // A statement of another function: its filter says nothing about this route.
      { kind: "database", name: "prisma.club.delete", target: null, entity: "club", access: "write", line: 3, calls: [], whereFields: [{ field: "id", origin: { kind: "param", name: "slug", index: 1 } }] },
    ],
  } as any);
  const routes = file("api/routes/clubs.ts", [], { routes: [route] } as any);
  const links = [
    link("api/routes/clubs.ts", "route:GET /clubs/:slug", 4, "getClub", "api/services/clubs.ts", "getClub"),
    link("api/services/clubs.ts", "getClub", 2, "findClub", "api/services/clubs.ts", "findClub"),
  ];

  it("follows a route parameter from the request read through the calls that hand it on, to the field a statement filters on", () => {
    const rows = computeParamColumns({ analyses: [routes, service], symbolLinks: links, routes: [route] });
    expect(rows).toEqual([{
      route: { file: "api/routes/clubs.ts", line: 3, method: "GET", path: "/clubs/:slug", param: "slug", binding: "route" },
      column: { entity: "club", field: "slug", file: "api/services/clubs.ts", line: 7, access: "read", call: "prisma.club.findUnique" },
      hops: [{ file: "api/services/clubs.ts", symbol: "getClub", line: 1, arg: 0 }, { file: "api/services/clubs.ts", symbol: "findClub", line: 6, arg: 0 }],
      confidence: "EXTRACTED",
    }]);
  });

  it("starts at a handler function's parameter of the route parameter's name", () => {
    const handled = { ...route, handler: "ClubsController.show", calls: [] };
    const controller = file("api/clubs.controller.ts", [], { classes: [{ name: "ClubsController", methods: [fn("show", 10, 14, ["slug"], [{ name: "this.clubs.findClub", kind: "internal", target: null, line: 12, argOrigins: [{ index: 0, origin: { kind: "param", name: "slug", index: 0 } }] }])] }] } as any);
    const rows = computeParamColumns({
      analyses: [routes, service, controller],
      symbolLinks: [link("api/routes/clubs.ts", "route:GET /clubs/:slug", 3, "ClubsController.show", "api/clubs.controller.ts", "ClubsController.show"), link("api/clubs.controller.ts", "ClubsController.show", 12, "this.clubs.findClub", "api/services/clubs.ts", "findClub")],
      routes: [handled],
    });
    expect(rows.map((r) => [r.route.param, `${r.column.entity}.${r.column.field}`, r.hops.map((h) => h.symbol).join(" → ")])).toEqual([["slug", "club.slug", "ClubsController.show → findClub"]]);
  });

  it("is empty when no statement reports filter fields", () => {
    expect(computeParamColumns({ analyses: [routes, file("api/services/clubs.ts", [])], symbolLinks: links, routes: [route] })).toEqual([]);
  });
});
