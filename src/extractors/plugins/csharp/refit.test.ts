import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { CSharpDataSourceExtractor } from "./data-sources.js";
import { extractCsharpHttpClientRegistrations } from "./http-clients.js";

async function parsed(src: string) {
  return { src, tree: await parseSource(src, "csharp" as any, "Clubs.cs") };
}

describe("Refit interfaces", () => {
  it("reads each verb attribute as a request through the client named for the interface", async () => {
    const { src, tree } = await parsed(`using Refit;
namespace League.Web;
public interface IClubApi {
    [Get("/{id}")]
    Task<Club> GetClub(int id);
    [Post("")] Task CreateClub([Body] Club club);
    [Headers("Accept: application/json")]
    [Delete("players/{playerId}?force=true")]
    Task RemovePlayer(int playerId);
    Task<string> NotARequest();
}`);
    const rows = new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(rows.map((r) => `${r.line} ${r.name} ${r.target} ${r.baseRef?.kind}:${r.baseRef?.key}`)).toEqual([
      "4 GET ${IClubApi}/{id} client:IClubApi",
      "6 POST ${IClubApi}/ client:IClubApi",
      "8 DELETE ${IClubApi}/players/{playerId} client:IClubApi",
    ]);
  });

  it("reads nothing from an interface in a file without Refit", async () => {
    const { src, tree } = await parsed(`public interface IClubs { [Get("/x")] Task X(); }`);
    expect(new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call")).toEqual([]);
  });

  it("registers the base AddRefitClient and RestService.For give the interface's client", async () => {
    const { src, tree } = await parsed(`using Refit;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRefitClient<IClubApi>().ConfigureHttpClient(c => c.BaseAddress = new Uri("http://clubs-api/api/clubs"));
var kits = RestService.For<IKitApi>(builder.Configuration["Services:Kits"]);
`);
    expect(extractCsharpHttpClientRegistrations(tree, src).map(({ line: _l, ...r }) => r)).toEqual([
      { client: "IClubApi", scope: "project", base: { kind: "literal", key: "http://clubs-api/api/clubs" } },
      { client: "IKitApi", scope: "project", base: { kind: "config", key: "Services:Kits" } },
    ]);
  });
});
