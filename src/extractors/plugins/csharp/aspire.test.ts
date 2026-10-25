import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { extractAspireResources } from "./aspire.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

const APPHOST = `var builder = DistributedApplication.CreateBuilder(args);

// The data the league runs on.
var db = builder.AddPostgres("pg").AddDatabase("leaguedb");
var cache = builder.AddRedis("cache");
var api = builder.AddProject<Projects.League_Api>("apiservice")
    .WithReference(db)
    .WaitFor(db);
builder.AddProject<Projects.League_Web>("webfrontend")
    .WithExternalHttpEndpoints()
    .WithReference(cache)
    .WithReference(api);
builder.AddNpmApp("scoreboard", "../scoreboard").WithReference(api);

builder.Build().Run();
`;

describe("Aspire AppHost resources", () => {
  it("reads each resource, the project it runs and what it references", () => {
    const got = extractAspireResources(APPHOST).map((r) => ({ name: r.name, kind: r.kind, runs: r.runs, edges: r.edges?.map((e) => `${e.kind}:${e.to}`) }));
    expect(got).toEqual([
      { name: "pg", kind: "datastore", runs: undefined, edges: undefined },
      { name: "leaguedb", kind: "datastore", runs: undefined, edges: undefined },
      { name: "cache", kind: "cache", runs: undefined, edges: undefined },
      { name: "apiservice", kind: "app", runs: "League_Api", edges: ["db:leaguedb"] },
      { name: "webfrontend", kind: "app", runs: "League_Web", edges: ["db:cache", "http:apiservice"] },
      { name: "scoreboard", kind: "app", runs: "../scoreboard", edges: ["http:apiservice"] },
    ]);
  });

  it("reads nothing from a program that builds no distributed application", () => {
    expect(extractAspireResources(`var app = WebApplication.CreateBuilder(args).Build(); app.Run();`)).toEqual([]);
  });
});

describe("Aspire service discovery joins a call to the project it names", () => {
  let dir: string;
  const files: Record<string, string> = {
    "League.AppHost/League.AppHost.csproj": `<Project Sdk="Microsoft.NET.Sdk"><Sdk Name="Aspire.AppHost.Sdk" Version="9.0.0" /></Project>`,
    "League.AppHost/Program.cs": APPHOST,
    "League.Api/League.Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`,
    "League.Api/Program.cs": `var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet("/clubs", () => new[] { "Rovers" });\napp.Run();\n`,
    "League.Web/League.Web.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`,
    "League.Web/Program.cs": `var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddHttpClient<ClubsClient>(client => client.BaseAddress = new("https+http://apiservice"));\nbuilder.Build().Run();\n`,
    "League.Web/ClubsClient.cs": `public class ClubsClient(HttpClient http) {\n  public Task<string[]?> GetClubs() => http.GetFromJsonAsync<string[]>("/clubs");\n}\n`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-aspire-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("puts each project resource in the address book under its resource name", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const projectOf = (name: string) => summary.deployment?.services.find((s) => s.name === name)?.project;
    expect(projectOf("apiservice")).toBe(summary.subProjects.find((p) => p.name === "League.Api")?.id);
    expect(projectOf("webfrontend")).toBe(summary.subProjects.find((p) => p.name === "League.Web")?.id);
    const call = summary.apiCalls?.find((c) => c.filePath === "League.Web/ClubsClient.cs");
    expect(call?.origin?.project).toBe(projectOf("apiservice"));
    expect(summary.apiRouteLinks?.some((l) => l.source === "League.Web/ClubsClient.cs" && l.target === "League.Api/Program.cs")).toBe(true);
  });
});
