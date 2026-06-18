import { describe, it, expect } from "vitest";
import { linkApiCallsToRoutes, normalizeRoutePath } from "./route-linker.js";
import type { DataSourceInfo, RouteInfo } from "../types/analysis.js";

const apiCall = (
  filePath: string,
  name: string,
  target: string,
  line = 1,
): DataSourceInfo & { filePath: string } => ({
  kind: "api-call",
  name,
  target,
  calls: [],
  line,
  filePath,
});

const route = (
  filePath: string,
  httpMethod: string,
  path: string,
  handler: string,
  line = 1,
): RouteInfo & { filePath: string } => ({
  path,
  httpMethod,
  kind: "api",
  handler,
  calls: [],
  middleware: [],
  line,
  filePath,
});

describe("normalizeRoutePath", () => {
  it("collapses [controller] casing/kebab and route params/template literals", () => {
    expect(normalizeRoutePath("/AccessReport/roles/{roleId:guid}/holders")).toBe(
      normalizeRoutePath("/access-report/roles/${roleId}/holders"),
    );
    expect(normalizeRoutePath("/access-report/roles/${roleId}/holders")).toBe(
      "/accessreport/roles/{}/holders",
    );
  });

  it("normalizes express :params and strips host/query", () => {
    expect(normalizeRoutePath("https://api.x.com/users/:id?q=1")).toBe("/users/{}");
    expect(normalizeRoutePath("/api/Users/{id}")).toBe("/api/users/{}");
  });
});

describe("linkApiCallsToRoutes", () => {
  const routes = [
    route("Api/AccessReportController.cs", "GET", "/AccessReport/roles/{roleId}/holders", "GetRoleHolders", 29),
    route("Api/AccessReportController.cs", "POST", "/AccessReport/permission-set/holders", "GetPermissionSetHolders", 62),
    route("Api/UsersController.cs", "GET", "/api/Users/{id}", "GetById", 27),
    route("Api/UsersController.cs", "DELETE", "/api/Users/{id}", "Delete", 44),
  ];

  it("matches method + normalized path with EXTRACTED confidence", () => {
    const links = linkApiCallsToRoutes(
      [apiCall("web/api/accessReport.ts", "get", "/access-report/roles/${roleId}/holders", 47)],
      routes,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      source: "web/api/accessReport.ts",
      target: "Api/AccessReportController.cs",
      handler: "GetRoleHolders",
      method: "GET",
      confidence: "EXTRACTED",
    });
  });

  it("disambiguates two same-path routes by HTTP method", () => {
    const links = linkApiCallsToRoutes(
      [apiCall("web/api/users.ts", "delete", "/api/users/${id}")],
      routes,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ handler: "Delete", method: "DELETE", confidence: "EXTRACTED" });
  });

  it("marks AMBIGUOUS when the method can't disambiguate colliding routes", () => {
    const links = linkApiCallsToRoutes(
      [apiCall("web/api/users.ts", "fetch", "/api/users/${id}")], // 'fetch' is not an HTTP verb
      routes,
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.confidence).toBe("AMBIGUOUS");
  });

  it("drops unmatched and external calls", () => {
    const links = linkApiCallsToRoutes(
      [
        apiCall("web/api/x.ts", "get", "/nope/missing"),
        apiCall("web/api/x.ts", "get", "https://other.host/AccessReport/roles/${roleId}/holders"),
      ],
      routes,
    );
    expect(links).toHaveLength(0);
  });
});
