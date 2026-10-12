import { describe, it, expect } from "vitest";
import "../../../registry.js";
import { parseSource } from "../../../../parsers/parser-manager.js";
import { csharpRouteExtractor } from "./aspnet.js";

async function routes(src: string) {
  const tree = await parseSource(src, "csharp" as never, "CatalogApi.cs");
  return csharpRouteExtractor.extractRoutes(tree, src, "CatalogApi.cs", []);
}

describe("ASP.NET Minimal APIs", () => {
  it("reads MapGet/MapPost under MapGroup prefixes, with versions, auth and method-group handlers", async () => {
    const out = await routes(`public static class CatalogApi
{
    public static IEndpointRouteBuilder MapCatalogApi(this IEndpointRouteBuilder app)
    {
        var vApi = app.NewVersionedApi("Catalog");
        var api = vApi.MapGroup("api/catalog").HasApiVersion(1, 0).HasApiVersion(2, 0);
        var v1 = vApi.MapGroup("api/catalog").HasApiVersion(1, 0);
        var admin = api.MapGroup("admin").RequireAuthorization("Admin");

        v1.MapGet("/items", GetAllItemsV1)
            .WithName("ListItems");
        api.MapGet("/items/{id:int}", GetItemById);
        admin.MapDelete("/items/{id:int}", DeleteItemById);
        app.MapPost("/orders", async (CreateOrder cmd, IMediator mediator) => await mediator.Send(cmd))
            .RequireAuthorization();
        return app;
    }

    public static async Task<Ok<CatalogItem>> GetItemById(int id, CatalogContext db) => TypedResults.Ok(await db.CatalogItems.FindAsync(id));
}`);
    expect(out.map((r) => `${r.httpMethod} ${r.path} ${r.handler ?? "-"} v=${(r.versions ?? []).join("|")} ${r.middleware.join(",")}`)).toEqual([
      "GET /api/catalog/items GetAllItemsV1 v=1.0 ",
      "GET /api/catalog/items/{id} GetItemById v=1.0|2.0 ",
      "DELETE /api/catalog/admin/items/{id} DeleteItemById v=1.0|2.0 RequireAuthorization(\"Admin\")",
      "POST /orders - v= RequireAuthorization",
    ]);
    expect(out[3]!.calls.map((c) => c.name)).toContain("mediator.Send");
    expect(out[2]!.auth?.policies).toEqual(["Admin"]);
  });
});
