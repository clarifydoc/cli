import { describe, it, expect } from "vitest";
import "../../../registry.js";
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractAspnetRoutes } from "./aspnet.js";
import { extractPageModels, razorPageRoutes } from "./razor-pages.js";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";

async function controllerRoutes(source: string): Promise<RouteInfo[]> {
  const tree = await parseSource(source, "csharp" as any, "Api.cs");
  const routes: RouteInfo[] = [];
  extractAspnetRoutes(tree.rootNode, routes);
  return routes;
}

describe("ASP.NET ServiceFilter middlewareCalls", () => {
  it("names authorization filter entry methods for ServiceFilter and TypeFilter", async () => {
    const SRC = `namespace League.Api;
[ApiController]
[Route("api/[controller]")]
[ServiceFilter(typeof(StadiumAuthorizationFilter))]
public class FixturesController : ControllerBase {
    [HttpGet("{id}")]
    public Task<int> Get(int id) => Task.FromResult(id);

    [HttpPost]
    [TypeFilter(typeof(TicketAuditFilter))]
    public Task Post() => Task.CompletedTask;
}`;
    const routes = await controllerRoutes(SRC);
    expect(routes.find((r) => r.httpMethod === "GET")!.middlewareCalls).toEqual([
      "StadiumAuthorizationFilter.OnAuthorizationAsync",
      "StadiumAuthorizationFilter.OnAuthorization",
    ]);
    expect(routes.find((r) => r.httpMethod === "POST")!.middlewareCalls).toEqual([
      "StadiumAuthorizationFilter.OnAuthorizationAsync",
      "StadiumAuthorizationFilter.OnAuthorization",
      "TicketAuditFilter.OnActionExecutionAsync",
      "TicketAuditFilter.OnActionExecuting",
    ]);
    expect(routes.find((r) => r.httpMethod === "GET")!.filters?.map((f) => f.text)).toContain(
      "ServiceFilter(typeof(StadiumAuthorizationFilter))",
    );
  });

  it("carries class-level ServiceFilter onto Razor Page routes", async () => {
    const modelTree = await parseSource(
      `using Microsoft.AspNetCore.Mvc.RazorPages;
[ServiceFilter(typeof(ViewerAuthorizationFilter))]
public class StandingsModel : PageModel {
    public void OnGet() { }
}`,
      "csharp" as any,
      "Pages/Standings.cshtml.cs",
    );
    const facts: RouteFact[] = [];
    extractPageModels(modelTree.rootNode, facts);
    const cs = {
      language: "csharp",
      filePath: "Pages/Standings.cshtml.cs",
      projectId: "p",
      routes: [],
      routeFacts: facts,
    } as unknown as FileAnalysis;
    const view = {
      language: "razor",
      filePath: "Pages/Standings.cshtml",
      routes: [],
      screens: [{ routePath: "/standings" }],
    } as unknown as FileAnalysis;
    razorPageRoutes.resolve([cs, view], {} as any);
    expect(cs.routes[0]!.middlewareCalls).toEqual([
      "ViewerAuthorizationFilter.OnAuthorizationAsync",
      "ViewerAuthorizationFilter.OnAuthorization",
    ]);
  });
});