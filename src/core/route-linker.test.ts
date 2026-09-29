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

  it("canonicalizes an API-version segment (concrete v4 ≈ templated v{apiVersion})", () => {
    // A client URL carries a concrete version; an ASP.NET/versioned route carries
    // the template. Both must compare equal so the cross-tier join lands.
    expect(normalizeRoutePath("/api/v4/institution/{id}/vikarbesked")).toBe(
      normalizeRoutePath("/api/v{apiVersion}/institution/{institutionId}/vikarbesked"),
    );
    expect(normalizeRoutePath("/api/v1/license/product")).toBe("/api/v{}/license/product");
    // A non-version segment that merely starts with `v` is untouched.
    expect(normalizeRoutePath("/api/vendors/list")).toBe("/api/vendors/list");
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

  it("reads `del` as DELETE, so a superagent-style client disambiguates", () => {
    // `delete` is a reserved word, so superagent and friends spell the verb
    // `del`. Without the alias this matched on path alone and landed on
    // whichever route came first — here the GET — as INFERRED.
    const links = linkApiCallsToRoutes(
      [apiCall("web/api/users.ts", "del", "/api/users/${id}")],
      routes,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ handler: "Delete", method: "DELETE", confidence: "EXTRACTED" });
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

describe("linkApiCallsToRoutes — frontend client omits the base the route carries", () => {
  // `axios.create({ baseURL: "/api" })` then `client.get("/products")`: the
  // captured call URL is the base-less `/products`, but the backend route is
  // `/api/products`. The mirror of proxy-stripping — prepend a conventional base
  // to the call and retry.
  it("links a base-less call to the `/api`-prefixed route (downgraded confidence)", () => {
    const backend = [route("server/products.ts", "GET", "/api/products", "list", 5)];
    const links = linkApiCallsToRoutes([apiCall("web/api.ts", "get", "/products")], backend);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ routePath: "/api/products", handler: "list", confidence: "INFERRED" });
  });

  it("still prefers a literal match (no base prepended when the call already matches)", () => {
    const backend = [
      route("server/products.ts", "GET", "/products", "bare", 1),
      route("server/products.ts", "GET", "/api/products", "prefixed", 2),
    ];
    const links = linkApiCallsToRoutes([apiCall("web/api.ts", "get", "/products")], backend);
    expect(links[0]).toMatchObject({ handler: "bare", confidence: "EXTRACTED" });
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

describe("dedupeRoutes — identity is per sub-project and API-version set", () => {
  const inProject = (projectId: string, r: RouteInfo & { filePath: string }, extra: Partial<RouteInfo> = {}) => ({
    ...r,
    ...extra,
    projectId,
  });

  it("keeps the same method+path when two sub-projects host it", () => {
    // Tessa: Plan.API/V3/AktiviteterV3Controller.cs and
    // Vikardaekning.API/V2/AktivitetV2Controller.cs both serve the path; the
    // repo-wide dedupe kept one and attributed the other service's route to it.
    const plan = inProject("plan-api", route("Plan.API/V3/AktiviteterV3Controller.cs", "GET", "/api/v{version}/institution/{id}/aktiviteter", "Get"));
    const vikar = inProject("vikar-api", route("Vikardaekning.API/V2/AktivitetV2Controller.cs", "GET", "/api/v{version}/institution/{id}/aktiviteter", "Get"));
    const out = dedupeRoutes([plan, vikar]);
    expect(out.map((r) => r.filePath)).toEqual([plan.filePath, vikar.filePath]);
  });

  it("keeps versioned twins inside one sub-project apart", () => {
    const v2 = inProject("vikar-api", route("V2/PuljeV4Controller.cs", "GET", "/api/v{version}/puljer/myPuljer", "Get"), { versions: ["4"] });
    const v5 = inProject("vikar-api", route("V5/PuljeV5Controller.cs", "GET", "/api/v{version}/puljer/myPuljer", "Get"), { versions: ["5"] });
    expect(dedupeRoutes([v2, v5])).toHaveLength(2);
    // Same version set declared in a different order is the same identity.
    const a = inProject("p", route("a.cs", "GET", "/x", "A"), { versions: ["3", "4"] });
    const b = inProject("p", route("b.cs", "GET", "/x", "A"), { versions: ["4", "3"] });
    expect(dedupeRoutes([a, b])).toHaveLength(1);
  });

  it("still collapses the Rails duplicate (same project, no versions)", () => {
    const fromRoutesRb = inProject("root", route("config/routes.rb", "GET", "/absences", "AbsencesController#index", 12));
    const fromController = inProject("root", { ...route("app/controllers/absences_controller.rb", "GET", "/absences", "AbsencesController#index", 30), calls: [{ name: "Absence.all", kind: "internal", target: null, line: 31 }] });
    const out = dedupeRoutes([fromRoutesRb, fromController]);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe("app/controllers/absences_controller.rb");
  });
});

describe("linkApiCallsToRoutes — API version", () => {
  const versioned = (file: string, versions: string[], path = "/api/v{version}/institution/{institutionId}/puljer/myPuljer") => ({
    ...route(file, "GET", path, "MyPuljer"),
    versions,
  });
  const call = (target: string) => ({
    kind: "api-call" as const,
    name: "get",
    target,
    calls: [],
    line: 7,
    filePath: "spa/src/api/puljer.ts",
  });

  it("picks the twin that serves the version the client names", () => {
    const routes = [versioned("V4/PuljeV4Controller.cs", ["4"]), versioned("V5/PuljeV5Controller.cs", ["5"])];
    const [link] = linkApiCallsToRoutes([call("/api/v5/institution/${id}/puljer/myPuljer")], routes);
    expect(link).toMatchObject({ target: "V5/PuljeV5Controller.cs", confidence: "EXTRACTED", matchedVia: "exact" });
    const [older] = linkApiCallsToRoutes([call("/api/v4/institution/${id}/puljer/myPuljer")], routes);
    expect(older!.target).toBe("V4/PuljeV4Controller.cs");
  });

  it("treats `3` and `3.0` as one version and matches a multi-version controller", () => {
    const routes = [versioned("V2/C.cs", ["2"]), versioned("V3/C.cs", ["3.0", "4.0"])];
    const [link] = linkApiCallsToRoutes([call("/api/v3/institution/${id}/puljer/myPuljer")], routes);
    expect(link!.target).toBe("V3/C.cs");
    expect(link!.confidence).toBe("EXTRACTED");
  });

  it("flags a version no route declares serving, keeping the best guess downgraded", () => {
    const [link] = linkApiCallsToRoutes([call("/api/v9/institution/${id}/puljer/myPuljer")], [versioned("V2/C.cs", ["2"])]);
    expect(link).toMatchObject({ target: "V2/C.cs", confidence: "INFERRED", matchedVia: "version-mismatch" });
    // Several twins, none serving it: ambiguous AND flagged.
    const [multi] = linkApiCallsToRoutes(
      [call("/api/v9/institution/${id}/puljer/myPuljer")],
      [versioned("V2/C.cs", ["2"]), versioned("V3/C.cs", ["3"])],
    );
    expect(multi).toMatchObject({ confidence: "AMBIGUOUS", matchedVia: "version-mismatch" });
  });

  it("an unversioned route is unknown, not wrong: it wins only when no versioned twin serves the call", () => {
    const literal = route("Legacy/C.cs", "GET", "/api/v3/institution/{id}/puljer/myPuljer", "Old"); // literal version in the template, no [ApiVersion]
    const v5 = versioned("V5/C.cs", ["5"]);
    const [toV5] = linkApiCallsToRoutes([call("/api/v5/institution/${id}/puljer/myPuljer")], [literal, v5]);
    expect(toV5!.target).toBe("V5/C.cs");
    const [toLegacy] = linkApiCallsToRoutes([call("/api/v3/institution/${id}/puljer/myPuljer")], [literal, v5]);
    expect(toLegacy).toMatchObject({ target: "Legacy/C.cs", confidence: "EXTRACTED", matchedVia: "exact" });
  });

  it("is a no-op when the client URL carries no version", () => {
    const routes = [versioned("V4/C.cs", ["4"], "/api/puljer"), versioned("V5/C.cs", ["5"], "/api/puljer")];
    const [link] = linkApiCallsToRoutes([call("/api/puljer")], routes);
    expect(link).toMatchObject({ target: "V4/C.cs", confidence: "AMBIGUOUS" });
  });
});
