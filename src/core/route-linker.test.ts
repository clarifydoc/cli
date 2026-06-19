import { describe, it, expect } from "vitest";
import { linkApiCallsToRoutes, normalizeRoutePath, dedupeRoutes } from "./route-linker.js";
import type { CallInfo, DataSourceInfo, RouteInfo } from "../types/analysis.js";

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

  it("strips a trailing response-format extension (Rails .json/.xml)", () => {
    expect(normalizeRoutePath("/api/absences/${id}.json")).toBe("/api/absences/{}");
    expect(normalizeRoutePath("/feed.xml")).toBe("/feed");
    expect(normalizeRoutePath("/reports/summary.csv")).toBe("/reports/summary");
    // Only a trailing extension is dropped — a dotted middle segment survives.
    expect(normalizeRoutePath("/a.json/b")).toBe("/ajson/b");
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

describe("linkApiCallsToRoutes — Rails behind an /api proxy", () => {
  // Backend routes live at root (`/absences/:id`); the SPA calls `/api/absences/${id}.json`
  // because nginx (`location /api/ { proxy_pass http://app:3000/; }`) strips `/api` and
  // Rails serves the `.json` format. This is the ida topology.
  const railsRoutes = [
    route("app/controllers/absences_controller.rb", "GET", "/absences/:id", "AbsencesController#show", 12),
    route("app/controllers/absences_controller.rb", "DELETE", "/absences/:id", "AbsencesController#destroy", 40),
    route("app/controllers/departments_controller.rb", "GET", "/departments", "DepartmentsController#index", 5),
  ];

  it("links a `/api/x/:id.json` call to the proxy-stripped `/x/:id` route (method-exact → INFERRED)", () => {
    const links = linkApiCallsToRoutes(
      [apiCall("spa/src/api/axios/deleteApiAbsencesById.ts", "delete", "/api/absences/${id}.json", 15)],
      railsRoutes,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      target: "app/controllers/absences_controller.rb",
      handler: "AbsencesController#destroy",
      method: "DELETE",
      routePath: "/absences/:id",
      // Path matched only after stripping the conventional `/api` base path, so the
      // otherwise-EXTRACTED match is reported one rung softer.
      confidence: "INFERRED",
    });
  });

  it("links a collection-level `/api/departments.json` GET", () => {
    const links = linkApiCallsToRoutes(
      [apiCall("spa/src/api/axios/getApiDepartments.ts", "get", "/api/departments.json", 9)],
      railsRoutes,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ handler: "DepartmentsController#index", confidence: "INFERRED" });
  });

  it("downgrades to AMBIGUOUS when a prefix-stripped match can't be disambiguated by method", () => {
    const links = linkApiCallsToRoutes(
      [apiCall("spa/src/api/x.ts", "fetch", "/api/absences/${id}.json")], // 'fetch' is not a verb
      railsRoutes,
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.confidence).toBe("AMBIGUOUS");
  });

  it("prefers a literal match over prefix-stripping (no downgrade)", () => {
    // A backend that genuinely mounts under /api must still match at EXTRACTED.
    const literal = [route("api/UsersController.cs", "GET", "/api/users/{id}", "GetById", 27)];
    const links = linkApiCallsToRoutes(
      [apiCall("web/users.ts", "get", "/api/users/${id}")],
      literal,
    );
    expect(links[0]).toMatchObject({ confidence: "EXTRACTED", handler: "GetById" });
  });

  it("honors a caller-supplied base path (e.g. discovered from proxy config)", () => {
    const backend = [route("ctrl.rb", "GET", "/widgets/:id", "WidgetsController#show", 3)];
    // Default prefixes wouldn't strip `/internal`; an explicit basePath does.
    expect(linkApiCallsToRoutes([apiCall("c.ts", "get", "/internal/widgets/${id}.json")], backend)).toHaveLength(0);
    const links = linkApiCallsToRoutes(
      [apiCall("c.ts", "get", "/internal/widgets/${id}.json")],
      backend,
      { basePaths: ["/internal"] },
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ handler: "WidgetsController#show" });
  });
});

describe("dedupeRoutes", () => {
  const call = (name: string): CallInfo => ({ name, kind: "internal", target: null, line: 1 });
  const withCalls = (r: RouteInfo & { filePath: string }, calls: CallInfo[]) => ({ ...r, calls });

  it("collapses the Rails routes.rb + controller-convention duplicate, keeping the richer entry", () => {
    // routes.rb produces a code-less entry; the controller produces the real one.
    const fromRoutesRb = route("config/routes.rb", "GET", "/absences/vacation_days", "AbsencesController#vacation_days", 12);
    const fromController = withCalls(
      route("app/controllers/absences_controller.rb", "GET", "/absences/vacation_days", "AbsencesController#vacation_days", 88),
      [call("Absence.where")],
    );
    const out = dedupeRoutes([fromRoutesRb, fromController]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      filePath: "app/controllers/absences_controller.rb", // the one with call edges
      line: 88,
    });
    expect(out[0]!.calls).toHaveLength(1);
  });

  it("prefers a resolved #action handler over a class-only one when neither has calls", () => {
    // ActiveAdmin / resources expansion yields a class-only handler; an explicit
    // `get 'x' => 'ctrl#action'` yields the action-level one. Keep the latter.
    const classOnly = route("config/routes.rb", "POST", "/duties", "DutiesController", 3);
    const actionLevel = route("config/routes.rb", "POST", "/duties", "DutiesController#create", 9);
    expect(dedupeRoutes([classOnly, actionLevel])[0]!.handler).toBe("DutiesController#create");
    // Order-independent: the richer entry wins regardless of declaration order.
    expect(dedupeRoutes([actionLevel, classOnly])[0]!.handler).toBe("DutiesController#create");
  });

  it("keeps the entry carrying call edges (the controller action body)", () => {
    const fromRoutesRb = route("config/routes.rb", "POST", "/duties", "DutiesController#create", 3);
    const fromController = withCalls(
      route("app/controllers/duties_controller.rb", "POST", "/duties", "DutiesController#create", 50),
      [call("Duty.create!")],
    );
    const out = dedupeRoutes([fromRoutesRb, fromController]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ filePath: "app/controllers/duties_controller.rb", line: 50 });
    expect(out[0]!.calls.map((c) => c.name)).toEqual(["Duty.create!"]);
  });

  it("does not merge across method, kind, or distinct paths", () => {
    const routes = [
      route("a.rb", "GET", "/x", "A#i"),
      route("a.rb", "POST", "/x", "A#c"), // different method
      route("a.rb", "GET", "/x/:id", "A#s"), // different path
      { ...route("a.rb", "GET", "/x", "A#i"), kind: "frontend" as const }, // different kind
    ];
    expect(dedupeRoutes(routes)).toHaveLength(4);
  });

  it("preserves order and is a no-op on already-unique routes", () => {
    const routes = [
      route("a.rb", "GET", "/a", "A#i"),
      route("a.rb", "GET", "/b", "B#i"),
      route("a.rb", "GET", "/c", "C#i"),
    ];
    expect(dedupeRoutes(routes).map((r) => r.path)).toEqual(["/a", "/b", "/c"]);
  });
});
