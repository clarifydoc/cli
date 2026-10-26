import { describe, it, expect } from "vitest";
import { computeParamOrigins } from "./param-origins.js";
import type { ApiRouteLink, FileAnalysis, ScreenInfo, SymbolLink } from "../types/analysis.js";

const fn = (name: string, line: number, endLine: number, params: string[], calls: any[] = []): any =>
  ({ name, params: params.map((p) => ({ name: p, type: null, defaultValue: null })), returnType: null, isAsync: false, isExported: true, decorators: [], calls, line, endLine });
const file = (filePath: string, functions: any[], dataSources: any[] = []): FileAnalysis =>
  ({ filePath, language: "typescript", functions, classes: [], dataSources, imports: [], exports: [] }) as unknown as FileAnalysis;
const link = (sourceFile: string, sourceSymbol: string, sourceLine: number, callName: string, targetFile: string, targetSymbol: string): SymbolLink =>
  ({ sourceFile, sourceSymbol, sourceLine, callName, targetFile, targetSymbol, targetLine: 1, confidence: "EXTRACTED" }) as SymbolLink;

describe("paramOrigins", () => {
  // ClubPage reads :clubId and hands it to useClub, which hands it to getClub, whose URL carries it.
  const page = file("web/pages/ClubPage.tsx", [
    fn("ClubPage", 3, 9, [], [{ name: "useClub", kind: "cross-file", target: null, line: 5, argOrigins: [{ index: 0, origin: { kind: "route-param", name: "clubId" }, transform: "Number" }] }]),
    fn("TablePage", 11, 14, [], [{ name: "getClub", kind: "cross-file", target: null, line: 12, argOrigins: [{ index: 0, origin: { kind: "literal", value: "1" } }, { index: 1, origin: { kind: "param", name: "x", index: 0 } }] }]),
  ]);
  const hook = file("web/hooks/useClub.ts", [
    fn("useClub", 1, 6, ["clubId"], [{ name: "getClub", kind: "cross-file", target: null, line: 3, argOrigins: [{ index: 0, origin: { kind: "param", name: "clubId", index: 0 } }] }]),
  ]);
  const api = file("web/api/clubs.ts", [fn("getClub", 1, 3, ["id"]), fn("getAll", 5, 7, ["url"])], [
    { kind: "api-call", name: "http.get", target: "/api/v2/clubs/${id}", line: 2, calls: [] },
    { kind: "api-call", name: "http.get", target: "/api${url}", line: 6, calls: [] },
  ]);
  const links = [
    link("web/pages/ClubPage.tsx", "ClubPage", 5, "useClub", "web/hooks/useClub.ts", "useClub"),
    link("web/hooks/useClub.ts", "useClub", 3, "getClub", "web/api/clubs.ts", "getClub"),
    link("web/pages/ClubPage.tsx", "TablePage", 12, "getClub", "web/api/clubs.ts", "getClub"),
  ];
  const apiLink = { source: "web/api/clubs.ts", sourceLine: 2, method: "GET", url: "/api/v2/clubs/${id}", target: "api/ClubsController.cs", targetLine: 20, handler: "Get", routePath: "/api/v2/clubs/{id}", confidence: "EXTRACTED" } as ApiRouteLink;
  const screens = [{ name: "ClubPage", filePath: "web/pages/ClubPage.tsx", routePath: "/clubs/:clubId" }] as unknown as ScreenInfo[];
  const routes = [{ kind: "api", path: "/api/v2/clubs/{id}", httpMethod: "GET", handler: "Get", line: 20, filePath: "api/ClubsController.cs", params: [{ name: "id", type: "int", binding: "route" }] }] as any;

  it("follows a URL slot back through the calls that hand it on, to the screen's route parameter, and joins the route's parameter", () => {
    const rows = computeParamOrigins({ analyses: [page, hook, api], symbolLinks: links, apiRouteLinks: [apiLink], routes, screens });
    expect(rows.map((r) => [r.sink.slot, r.origin.kind, "name" in r.origin ? r.origin.name : "value" in r.origin ? r.origin.value : "", r.origin.file, r.hops.length])).toEqual([
      ["id", "route-param", "clubId", "web/pages/ClubPage.tsx", 2],
      ["id", "literal", "1", "web/pages/ClubPage.tsx", 1],
    ]);
    expect(rows[0]!.origin).toMatchObject({ screen: "ClubPage", routePath: "/clubs/:clubId", inRoutePath: true });
    expect(rows[0]!.route).toEqual({ file: "api/ClubsController.cs", line: 20, method: "GET", path: "/api/v2/clubs/{id}", param: "id", binding: "route", type: "int" });
    // `/api${url}` is a URL the caller composes, not a parameter: no row.
    expect(rows.some((r) => r.sink.slot === "url")).toBe(false);
  });

  it("is empty when no plugin reports argument origins", () => {
    const bare = file("web/api/clubs.ts", [fn("getClub", 1, 3, ["id"])], [{ kind: "api-call", name: "http.get", target: "/clubs/${id}", line: 2, calls: [] }]);
    expect(computeParamOrigins({ analyses: [bare], symbolLinks: [], apiRouteLinks: [], routes: [], screens: [] })).toEqual([]);
  });
});
