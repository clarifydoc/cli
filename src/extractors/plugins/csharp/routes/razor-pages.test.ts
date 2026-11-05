import { describe, it, expect } from "vitest";
import "../../../registry.js";
import { parseSource } from "../../../../parsers/parser-manager.js";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import { csharpRouteExtractor } from "./aspnet.js";
import { razorPageRoutes } from "./razor-pages.js";
import { fastEndpointPrefixes } from "./fast-endpoint-prefixes.js";

async function read(source: string, file = "C.cs") {
  const tree = await parseSource(source, "csharp" as any, file);
  const facts: RouteFact[] = [];
  const routes: RouteInfo[] = csharpRouteExtractor.extractRoutes(tree, source, file, facts) ?? [];
  return { routes, facts };
}

describe("FastEndpoints", () => {
  const SRC = `using FastEndpoints;
public class GetFixtureEndpoint : Endpoint<FixtureReq, FixtureRes> {
    public override void Configure() { Get("/api/fixtures/{Id:int}"); Roles("Admin"); }
    public override async Task HandleAsync(FixtureReq req, CancellationToken ct) { }
}
public class SaveFixtureEndpoint : Endpoint<FixtureReq> {
    public override void Configure() { Verbs(Http.POST, Http.PUT); Routes("/api/fixtures", "/api/v2/fixtures"); AllowAnonymous(); }
    public override async Task HandleAsync(FixtureReq req, CancellationToken ct) { }
}
public class GroupedEndpoint : EndpointWithoutRequest {
    public override void Configure() { Get("list"); Group<FixturesGroup>(); }
    public override async Task HandleAsync(CancellationToken ct) { }
}
public class Decoy { public void Configure() { Get("/nope"); } }`;
  it("reads verb, path, roles and handler from Configure()", async () => {
    const { routes } = await read(SRC);
    const rows = routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler} ${r.owner}`).sort();
    expect(rows).toEqual([
      "GET /api/fixtures/{Id} HandleAsync GetFixtureEndpoint",
      // A group's endpoint keeps its own path until the group's prefix is joined (`prefixUnresolved`).
      "GET /list HandleAsync GroupedEndpoint",
      "POST /api/fixtures HandleAsync SaveFixtureEndpoint",
      "POST /api/v2/fixtures HandleAsync SaveFixtureEndpoint",
      "PUT /api/fixtures HandleAsync SaveFixtureEndpoint",
      "PUT /api/v2/fixtures HandleAsync SaveFixtureEndpoint",
    ]);
    expect(routes.find((r) => r.path === "/api/fixtures/{Id}")!.auth?.roles).toEqual(["Admin"]);
    expect(routes.find((r) => r.httpMethod === "PUT")!.auth?.anonymous).toBe(true);
  });
});

describe("FastEndpoints groups and the global route prefix", () => {
  const analysis = async (file: string, src: string): Promise<FileAnalysis> => {
    const { routes, facts } = await read(src, file);
    return { language: "csharp", filePath: file, projectId: "p", routes, routeFacts: facts } as unknown as FileAnalysis;
  };
  it("joins the prefix of a Group<>() class and Endpoints.RoutePrefix, which an endpoint may opt out of", async () => {
    const program = await analysis("Program.cs", `app.UseFastEndpoints(c => { c.Endpoints.RoutePrefix = "api"; });`);
    const group = await analysis("ClubsGroup.cs", `public class ClubsGroup : Group { public ClubsGroup() { Configure("clubs", ep => { ep.Description(x => x.WithTags("Clubs")); }); } }`);
    const eps = await analysis("Eps.cs", `public class ListClubs : EndpointWithoutRequest {
    public override void Configure() { Get("list"); Group<ClubsGroup>(); }
    public override async Task HandleAsync(CancellationToken ct) { }
}
public class Health : EndpointWithoutRequest {
    public override void Configure() { Get("/health"); Options(x => x.DontAddRoutePrefix()); }
    public override async Task HandleAsync(CancellationToken ct) { }
}
public class ListCars : EndpointWithoutRequest {
    public override void Configure() { Get("/cars"); }
    public override async Task HandleAsync(CancellationToken ct) { }
}
public class Orphan : EndpointWithoutRequest {
    public override void Configure() { Get("x"); Group<MissingGroup>(); }
    public override async Task HandleAsync(CancellationToken ct) { }
}`);
    fastEndpointPrefixes.resolve([program, group, eps], {} as any);
    expect(eps.routes.map((r) => `${r.httpMethod} ${r.path}${r.prefixUnresolved ? " ?" : ""}`).sort()).toEqual([
      "GET /api/cars",
      "GET /api/clubs/list",
      "GET /health",
      "GET /x ?",
    ]);
  });
});

describe("Razor Pages", () => {
  it("pairs a PageModel's handlers with the page's @page template", async () => {
    const { facts, routes } = await read(`public class ClubModel : PageModel {
    public void OnGet(int id) { }
    public IActionResult OnPostSave(int id) => Page();
    public Task<IActionResult> OnPostAsync(int id) => null;
    public void OnGetHelper() { }
}`);
    expect(routes).toEqual([]);
    const cs = { language: "csharp", filePath: "Pages/Club.cshtml.cs", routes: [], routeFacts: facts } as unknown as FileAnalysis;
    const view = { language: "razor", filePath: "Pages/Club.cshtml", routes: [], screens: [{ routePath: "/clubs/{id:int}" }] } as unknown as FileAnalysis;
    const decoy = { language: "razor", filePath: "Pages/Other.cshtml", routes: [], screens: [{ routePath: "/other" }] } as unknown as FileAnalysis;
    razorPageRoutes.resolve([cs, view, decoy], {} as any);
    expect(cs.routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`).sort()).toEqual([
      "GET /clubs/{id} OnGet",
      "GET /clubs/{id}?handler=Helper OnGetHelper",
      "POST /clubs/{id} OnPostAsync",
      "POST /clubs/{id}?handler=Save OnPostSave",
    ]);
  });
});
