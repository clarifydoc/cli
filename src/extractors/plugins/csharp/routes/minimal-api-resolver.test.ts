import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { csharpRouteExtractor } from "./aspnet.js";
import { minimalApiGroupGuards } from "./minimal-api-resolver.js";
import { reconcileProjectRoutes } from "../../../route-resolvers/index.js";
import { buildImportIndex } from "../../../../core/import-index.js";
import { buildClassIndex } from "../../../../core/class-index.js";
import type { FileAnalysis, RouteFact } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";

async function analyze(files: Record<string, string>): Promise<FileAnalysis[]> {
  const out: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, "csharp" as never, filePath);
    const facts: RouteFact[] = [];
    const routes = csharpRouteExtractor.extractRoutes(tree, src, filePath, facts);
    out.push({ filePath, language: "csharp", projectId: "root", imports: [], exports: [], entityRelations: [], classes: [], routes, routeFacts: facts } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(out);
  const ctx: ProjectContext = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p) => out.find((a) => a.filePath === p) };
  reconcileProjectRoutes(out, ctx, [minimalApiGroupGuards]);
  return out;
}

describe("minimal-api-group-guards", () => {
  it("guards the endpoints a method maps on the group it returns with what its caller chains on the call (real-repo FP)", async () => {
    const out = await analyze({
      "Fixtures.Api/Apis/FixturesApi.cs": `
public static class FixturesApi
{
    public static RouteGroupBuilder MapFixturesApiV1(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("api/fixtures").HasApiVersion(1.0);
        var admin = api.MapGroup("admin");
        api.MapGet("/", GetFixtures);
        admin.MapDelete("{id:int}", DeleteFixture);
        app.MapGet("/health", Health);
        return api;
    }
}`,
      "Fixtures.Api/Program.cs": `
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var fixtures = app.NewVersionedApi("Fixtures");
fixtures.MapFixturesApiV1()
    .RequireAuthorization("Steward");
app.Run();
`,
    });
    const rows = out.flatMap((a) => a.routes).map((r) => `${r.httpMethod} ${r.path} [${r.auth?.policies.join(",") ?? "-"}] ${r.middleware.join(" | ")}`).sort();
    expect(rows).toEqual([
      'DELETE /api/fixtures/admin/{id} [Steward] RequireAuthorization("Steward")',
      'GET /api/fixtures [Steward] RequireAuthorization("Steward")',
      "GET /health [-] ",
    ]);
  });
});
