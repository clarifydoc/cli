import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** `CreatedAtRoute("…")` joins POST create to the GET route registered under that `Name =`. */
const ASPNET: Record<string, string> = {
  "League/League.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n`,
  "League/Controllers/GamesController.cs": `using Microsoft.AspNetCore.Mvc;

namespace League.Controllers;

[ApiController]
[Route("api/[controller]")]
public class GamesController : ControllerBase
{
    [HttpGet("{id}", Name = "GetGame")]
    public IActionResult Get(int id) => Ok();

    [HttpPost]
    public IActionResult Create(Game game) => CreatedAtRoute("GetGame", new { id = game.Id }, game);

    [HttpGet("standings", Name = "GetStandings")]
    public IActionResult Standings() => Ok();
}
`,
  "League/Models/Game.cs": `namespace League.Controllers;

public class Game
{
    public int Id { get; set; }
}
`,
};

describe("ASP.NET CreatedAtRoute", () => {
  let summary: ProjectAnalysis;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-created-at-route-"));
    for (const [rel, text] of Object.entries(ASPNET)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
    cleanup = () => rm(dir, { recursive: true, force: true });
  }, 120_000);

  afterAll(async () => {
    await cleanup();
  });

  it("sets redirectsTo on POST to the path of the route named GetGame, not the decoy", () => {
    const post = (summary.routeMap ?? []).find((r) => r.httpMethod === "POST" && r.path === "/api/Games");
    const getGame = (summary.routeMap ?? []).find((r) => r.name === "GetGame");
    const decoy = (summary.routeMap ?? []).find((r) => r.name === "GetStandings");
    expect(getGame?.path).toBe("/api/Games/{id}");
    expect(decoy?.path).toBe("/api/Games/standings");
    expect(post?.redirectsTo).toEqual(["/api/Games/{id}"]);
    expect(post?.redirectsTo).not.toContain(decoy?.path);
  });
});