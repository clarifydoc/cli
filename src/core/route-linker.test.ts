import { describe, it, expect } from "vitest";
import {
  linkApiCallsToRoutes,
  linkApiCallsToRoutesDetailed,
  normalizeRoutePath,
  dedupeRoutes,
  pairContractTwins,
} from "./route-linker.js";
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
    expect(normalizeRoutePath("/api/v4/institution/{id}/teamtalk")).toBe(
      normalizeRoutePath("/api/v{apiVersion}/institution/{institutionId}/teamtalk"),
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
  // Rails serves the `.json` format. This is the match-centre topology.
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
    // A real repo: Plan.API/V3/TrainingsV3Controller.cs and
    // Substitutions.API/V2/TrainingV2Controller.cs both serve the path; the
    // repo-wide dedupe kept one and attributed the other service's route to it.
    const plan = inProject("plan-api", route("Plan.API/V3/TrainingsV3Controller.cs", "GET", "/api/v{version}/institution/{id}/trainings", "Get"));
    const substitute = inProject("substitute-api", route("Substitutions.API/V2/TrainingV2Controller.cs", "GET", "/api/v{version}/institution/{id}/trainings", "Get"));
    const out = dedupeRoutes([plan, substitute]);
    expect(out.map((r) => r.filePath)).toEqual([plan.filePath, substitute.filePath]);
  });

  it("keeps versioned twins inside one sub-project apart", () => {
    const v2 = inProject("substitute-api", route("V2/LeagueV4Controller.cs", "GET", "/api/v{version}/leagues/myLeagues", "Get"), { versions: ["4"] });
    const v5 = inProject("substitute-api", route("V5/LeagueV5Controller.cs", "GET", "/api/v{version}/leagues/myLeagues", "Get"), { versions: ["5"] });
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
  const versioned = (file: string, versions: string[], path = "/api/v{version}/institution/{institutionId}/leagues/myLeagues") => ({
    ...route(file, "GET", path, "MyLeagues"),
    versions,
  });
  const call = (target: string) => ({
    kind: "api-call" as const,
    name: "get",
    target,
    calls: [],
    line: 7,
    filePath: "spa/src/api/leagues.ts",
  });

  it("picks the twin that serves the version the client names", () => {
    const routes = [versioned("V4/LeagueV4Controller.cs", ["4"]), versioned("V5/LeagueV5Controller.cs", ["5"])];
    const [link] = linkApiCallsToRoutes([call("/api/v5/institution/${id}/leagues/myLeagues")], routes);
    expect(link).toMatchObject({ target: "V5/LeagueV5Controller.cs", confidence: "EXTRACTED", matchedVia: "exact" });
    const [older] = linkApiCallsToRoutes([call("/api/v4/institution/${id}/leagues/myLeagues")], routes);
    expect(older!.target).toBe("V4/LeagueV4Controller.cs");
  });

  it("treats `3` and `3.0` as one version and matches a multi-version controller", () => {
    const routes = [versioned("V2/C.cs", ["2"]), versioned("V3/C.cs", ["3.0", "4.0"])];
    const [link] = linkApiCallsToRoutes([call("/api/v3/institution/${id}/leagues/myLeagues")], routes);
    expect(link!.target).toBe("V3/C.cs");
    expect(link!.confidence).toBe("EXTRACTED");
  });

  it("flags a version no route declares serving, keeping the best guess as a guess", () => {
    // AMBIGUOUS, not merely downgraded: a link to a version the client does not
    // call must never become a trace edge.
    const [link] = linkApiCallsToRoutes([call("/api/v9/institution/${id}/leagues/myLeagues")], [versioned("V2/C.cs", ["2"])]);
    expect(link).toMatchObject({ target: "V2/C.cs", confidence: "AMBIGUOUS", matchedVia: "version-mismatch" });
    // Several twins, none serving it: ambiguous AND flagged.
    const [multi] = linkApiCallsToRoutes(
      [call("/api/v9/institution/${id}/leagues/myLeagues")],
      [versioned("V2/C.cs", ["2"]), versioned("V3/C.cs", ["3"])],
    );
    expect(multi).toMatchObject({ confidence: "AMBIGUOUS", matchedVia: "version-mismatch" });
  });

  it("an unversioned route is unknown, not wrong: it wins only when no versioned twin serves the call", () => {
    const literal = route("Legacy/C.cs", "GET", "/api/v3/institution/{id}/leagues/myLeagues", "Old"); // literal version in the template, no [ApiVersion]
    const v5 = versioned("V5/C.cs", ["5"]);
    const [toV5] = linkApiCallsToRoutes([call("/api/v5/institution/${id}/leagues/myLeagues")], [literal, v5]);
    expect(toV5!.target).toBe("V5/C.cs");
    const [toLegacy] = linkApiCallsToRoutes([call("/api/v3/institution/${id}/leagues/myLeagues")], [literal, v5]);
    expect(toLegacy).toMatchObject({ target: "Legacy/C.cs", confidence: "EXTRACTED", matchedVia: "exact" });
  });

  it("is a no-op when the client URL carries no version", () => {
    const routes = [versioned("V4/C.cs", ["4"], "/api/leagues"), versioned("V5/C.cs", ["5"], "/api/leagues")];
    const [link] = linkApiCallsToRoutes([call("/api/leagues")], routes);
    expect(link).toMatchObject({ target: "V4/C.cs", confidence: "AMBIGUOUS" });
  });
});

describe("linkApiCallsToRoutes — target alternatives", () => {
  it("falls back to the next alternative URL when the primary reaches no route", () => {
    // A `staffOrAdminUrl(sub)` helper resolves to `/api/staff/<sub>`
    // for employees and `/api/<sub>` for admins; only the admin twin exists
    // for this endpoint, so the link must follow the alternative.
    const call = { ...apiCall("svc.ts", "get", "/api/staff/request_absence/absence_requests"), targetAlternatives: ["/api/request_absence/absence_requests"] };
    const rt = route("routes.rb", "GET", "/request_absence/absence_requests", "RequestAbsenceController#get_absence_requests");
    const links = linkApiCallsToRoutes([call], [rt]);
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe("/api/request_absence/absence_requests");
    expect(links[0]!.matchedVia).toBe("base-prefix:/api");
  });

  it("prefers the primary URL when both branches reach a route", () => {
    const call = { ...apiCall("svc.ts", "get", "/api/staff/duties"), targetAlternatives: ["/api/duties"] };
    const staff = route("staff/duties_controller.rb", "GET", "/staff/duties", "Staff::DutiesController#index");
    const admin = route("duties_controller.rb", "GET", "/duties", "DutiesController#index");
    const links = linkApiCallsToRoutes([call], [admin, staff]);
    expect(links).toHaveLength(1);
    expect(links[0]!.handler).toBe("Staff::DutiesController#index");
  });
});

describe("linkApiCallsToRoutes — wildcard-only URLs", () => {
  it("never joins a URL whose path is nothing but wildcards", () => {
    // `configService.APIUrl(url)` with a bare variable resolves to `/api/{}`;
    // after the `/api` base is stripped that is `/{}`, which must not land on
    // a `/:id` route by accident.
    const links = linkApiCallsToRoutes(
      [apiCall("svc.ts", "get", "/api/{}"), apiCall("svc.ts", "get", "/${id}"), apiCall("svc.ts", "get", "/{}/{}")],
      [route("routes.rb", "GET", "/:id", "ThingsController#show"), route("routes.rb", "GET", "/:a/:b", "PairsController#show")],
    );
    expect(links).toHaveLength(0);
  });

  it("still joins the root route — `/` has no segments, not a wildcard one", () => {
    const links = linkApiCallsToRoutes(
      [apiCall("server.spec.ts", "get", "/")],
      [route("main.ts", "GET", "/", "root")],
    );
    expect(links).toHaveLength(1);
  });
});

describe("normalizeRoutePath — holes before separators", () => {
  it("keeps a `?` inside a template-literal hole from cutting the path", () => {
    expect(normalizeRoutePath("/api/${isAdmin ? 'a' : 'b'}/items")).toBe("/api/{}/items");
  });

  it("counts nested braces, so one hole stays one hole", () => {
    expect(normalizeRoutePath("/api/${fn({ a: 1 })}/x")).toBe("/api/{}/x");
  });

  it("reads Flask/Django converters as parameters", () => {
    expect(normalizeRoutePath("/items/<int:id>/")).toBe("/items/{}");
    expect(normalizeRoutePath("users/<pk>/notes")).toBe("/users/{}/notes");
  });

  it("reduces a Django re_path regex to the path it matches", () => {
    expect(normalizeRoutePath("^users/(?P<pk>[^/.]+)/$")).toBe("/users/{}");
    expect(normalizeRoutePath("^documents/(?P<pk>\\d+)/versions/(?P<version_id>\\d+)/?$")).toBe(
      "/documents/{}/versions/{}",
    );
    expect(normalizeRoutePath("^$")).toBe("/");
    expect(normalizeRoutePath("^api/statistics/$")).toBe("/api/statistics");
  });

  it("drops a format-suffix group like a response extension", () => {
    expect(normalizeRoutePath("^users\\.(?P<format>[a-z0-9]+)/?$")).toBe("/users");
    expect(normalizeRoutePath("/users.{format}")).toBe("/users");
  });

  it("keeps ASP.NET constraints and catch-alls as one parameter", () => {
    expect(normalizeRoutePath("/api/files/{id:regex(^\\d+$)}")).toBe("/api/files/{}");
    expect(normalizeRoutePath("/spa/{*path}")).toBe("/spa/{}");
  });
});

describe("linkApiCallsToRoutes — normalized base prefixes", () => {
  it("strips a concrete `/api/vN` base, not just `/api/v1` and `/api/v2`", () => {
    const links = linkApiCallsToRoutes(
      [apiCall("web/movie.js", "post", "/api/v3/movie")],
      [route("api/MovieController.cs", "POST", "/movie", "AddMovie")],
    );
    expect(links[0]).toMatchObject({ target: "api/MovieController.cs", matchedVia: "base-prefix:/api/v{}" });
  });

  it("mirrors a versioned base the route carries but the call omits", () => {
    const links = linkApiCallsToRoutes(
      [apiCall("web/movie.js", "post", "/movie")],
      [route("openapi.json", "POST", "/api/v3/movie", "post_movie")],
    );
    expect(links[0]).toMatchObject({ target: "openapi.json", matchedVia: "base-prefix:/api/v{}", confidence: "INFERRED" });
  });

  it("joins a route path written without a slash", () => {
    const links = linkApiCallsToRoutes([apiCall("web/a.js", "get", "/health")], [route("urls.py", "GET", "health", "health")]);
    expect(links).toHaveLength(1);
  });
});

describe("linkApiCallsToRoutes — what the call itself knows", () => {
  it("never makes a link surer than the URL the extractor was unsure of", () => {
    const call = { ...apiCall("web/a.js", "get", "/api/x"), targetConfidence: "AMBIGUOUS" as const };
    const links = linkApiCallsToRoutes([call], [route("srv/x.ts", "GET", "/api/x", "x")]);
    expect(links[0]!.confidence).toBe("AMBIGUOUS");
  });

  it("reads the API version from `?api-version=` when the path carries none", () => {
    const v = (file: string, versions: string[]) => ({ ...route(file, "GET", "/api/catalog/items", "Items"), versions });
    const links = linkApiCallsToRoutes(
      [apiCall("web/catalog.ts", "get", "/api/catalog/items?api-version=2.0")],
      [v("Catalog/V1.cs", ["1.0"]), v("Catalog/V2.cs", ["2.0"])],
    );
    expect(links[0]).toMatchObject({ target: "Catalog/V2.cs", confidence: "EXTRACTED" });
  });
});

describe("linkApiCallsToRoutes — method policy", () => {
  it("refuses a route that serves another method, whichever tier found it (Radarr)", () => {
    // `POST /movie`: the literal path is BlocklistController's GET; the
    // /api/v3 contract row serving POST is one tier further.
    const blocklist = route("Blocklist/BlocklistController.cs", "GET", "/movie", "GetMovieBlocklist");
    const contract = route("openapi.json", "POST", "/api/v3/movie", "post_movie");
    const links = linkApiCallsToRoutes([apiCall("web/addMovie.js", "post", "/movie")], [blocklist, contract]);
    expect(links[0]).toMatchObject({ target: "openapi.json", matchedVia: "base-prefix:/api/v{}" });
  });

  it("refuses outright when only another method is served, and counts it", () => {
    const { links, stats } = linkApiCallsToRoutesDetailed(
      [apiCall("web/a.js", "put", "/api/filters")],
      [route("srv/filters.go", "POST", "/api/filters", "create")],
    );
    expect(links).toEqual([]);
    expect(stats).toMatchObject({ calls: 1, joinable: 1, linked: 0, refused: { methodMismatch: 1 } });
  });

  it("falls back to a route that takes any method, as INFERRED", () => {
    const anyRoute = { ...route("app.clj", "ANY", "/legacy", "legacy") };
    const links = linkApiCallsToRoutes([apiCall("web/a.js", "post", "/legacy")], [anyRoute]);
    expect(links[0]).toMatchObject({ confidence: "INFERRED", matchedVia: "method-fallback" });
  });

  it("serves HEAD with GET", () => {
    const links = linkApiCallsToRoutes([apiCall("web/a.js", "head", "/api/x")], [route("srv/x.ts", "GET", "/api/x", "x")]);
    expect(links[0]!.confidence).toBe("EXTRACTED");
  });

  it("still links a call whose method is unknown, on path alone", () => {
    const links = linkApiCallsToRoutes([apiCall("web/a.js", "fetch", "/api/x")], [route("srv/x.ts", "POST", "/api/x", "x")]);
    expect(links[0]).toMatchObject({ confidence: "INFERRED", matchedVia: "method-fallback" });
  });

  it("reads a version written in the route path: v2 is not v1", () => {
    const v1 = route("pkg/routes.go", "GET", "/api/v1/tasks/:id", "getTask");
    const [link] = linkApiCallsToRoutes([apiCall("e2e/task.spec.ts", "get", "/api/v2/tasks/${id}")], [v1]);
    expect(link).toMatchObject({ confidence: "AMBIGUOUS", matchedVia: "version-mismatch" });
  });
});

describe("linkApiCallsToRoutes — code rows and their API-contract twins", () => {
  const isContract = (r: { filePath: string }) => r.filePath.endsWith(".json");

  it("prefers the implementing code row over the contract row for the same endpoint (immich)", () => {
    const ctl = route("server/src/controllers/album.controller.ts", "GET", "/api/albums", "getAllAlbums", 40);
    const spec = route("open-api/immich-openapi-specs.json", "GET", "/api/albums", "getAllAlbums", 900);
    const twins = pairContractTwins([ctl, spec], [], isContract);
    const links = linkApiCallsToRoutes([apiCall("web/albums.ts", "get", "/api/albums")], [spec, ctl], {
      isContract,
      contractTwins: twins,
    });
    expect(links[0]).toMatchObject({ target: ctl.filePath, confidence: "EXTRACTED", matchedVia: "exact" });
  });

  it("still ranks code above an unpaired contract row", () => {
    const ctl = route("srv/a.ts", "GET", "/api/x", "x");
    const spec = route("spec.json", "GET", "/api/x", "x2");
    const links = linkApiCallsToRoutes([apiCall("web/a.ts", "get", "/api/x")], [spec, ctl], { isContract });
    expect(links[0]).toMatchObject({ target: "srv/a.ts", confidence: "EXTRACTED" });
  });

  it("lands on the code twin a spec join found when the code row knows only its tail", () => {
    // Radarr: the controller row is prefix-less (`/movie`), the contract row
    // carries the real path; the symbol linker's spec join tied the operation
    // to MovieController.AddMovie.
    const ctl = route("Movies/MovieController.cs", "POST", "/movie", "AddMovie", 120);
    const spec = route("openapi.json", "POST", "/api/v3/movie", "post_api_v3_movie", 5000);
    const join = {
      sourceFile: "openapi.json",
      sourceLine: 5000,
      targetFile: "Movies/MovieController.cs",
      targetSymbol: "MovieController.AddMovie",
      targetLine: 121,
      strategy: "spec-join",
    };
    const twins = pairContractTwins([ctl, spec], [join], isContract);
    expect(twins.get(spec)).toBe(ctl);
    const [link] = linkApiCallsToRoutes([apiCall("web/addMovie.js", "post", "/api/v3/movie")], [ctl, spec], {
      isContract,
      contractTwins: twins,
    });
    expect(link).toMatchObject({ target: ctl.filePath, targetLine: 120, routePath: "/api/v3/movie", confidence: "EXTRACTED" });
  });

  it("pairs nothing when several code rows could be the twin", () => {
    const a = route("svcA/x.ts", "GET", "/api/x", "x");
    const b = route("svcB/x.ts", "GET", "/api/x", "x");
    const spec = route("spec.json", "GET", "/api/x", "x");
    expect(pairContractTwins([a, b, spec], [], isContract).size).toBe(0);
  });
});

describe("linkApiCallsToRoutes — same sub-project breaks a tie", () => {
  it("prefers the route the call's own service declares", () => {
    const own = { ...route("svcA/routes.ts", "GET", "/api/x", "x"), projectId: "svcA" };
    const other = { ...route("svcB/routes.ts", "GET", "/api/x", "x"), projectId: "svcB" };
    const projectOf = (f: string) => f.split("/")[0];
    const links = linkApiCallsToRoutes([apiCall("svcA/test/x.spec.ts", "get", "/api/x")], [other, own], { projectOf });
    expect(links[0]).toMatchObject({ target: "svcA/routes.ts", confidence: "EXTRACTED" });
    const fromWeb = linkApiCallsToRoutes([apiCall("web/x.ts", "get", "/api/x")], [other, own], { projectOf });
    expect(fromWeb[0]!.confidence).toBe("AMBIGUOUS");
  });
});

describe("linkApiCallsToRoutesDetailed — stats", () => {
  it("accounts for every call", () => {
    const { stats } = linkApiCallsToRoutesDetailed(
      [
        apiCall("web/a.js", "get", "/api/x"),
        apiCall("web/a.js", "get", "/${kind}/${id}"),
        apiCall("web/a.js", "get", "/nothing/here"),
        apiCall("web/a.js", "get", "https://example.com/x"),
      ],
      [route("srv/x.ts", "GET", "/api/x", "x")],
    );
    expect(stats).toEqual({
      calls: 4,
      joinable: 3,
      linked: 1,
      refused: { methodMismatch: 0, wildcardOnly: 1 },
      unmatched: 1,
    });
  });
});
