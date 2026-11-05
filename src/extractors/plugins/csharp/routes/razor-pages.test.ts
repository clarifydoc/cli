import { describe, it, expect } from "vitest";
import "../../../registry.js";
import { parseSource } from "../../../../parsers/parser-manager.js";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import { csharpRouteExtractor } from "./aspnet.js";
import { razorPageRoutes } from "./razor-pages.js";

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
      "POST /api/fixtures HandleAsync SaveFixtureEndpoint",
      "POST /api/v2/fixtures HandleAsync SaveFixtureEndpoint",
      "PUT /api/fixtures HandleAsync SaveFixtureEndpoint",
      "PUT /api/v2/fixtures HandleAsync SaveFixtureEndpoint",
    ]);
    expect(routes.find((r) => r.path === "/api/fixtures/{Id}")!.auth?.roles).toEqual(["Admin"]);
    expect(routes.find((r) => r.httpMethod === "PUT")!.auth?.anonymous).toBe(true);
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
    expect(cs.routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`).sort()).toEqual(["GET /clubs/{id} OnGet", "POST /clubs/{id} OnPostAsync"]);
  });
});
