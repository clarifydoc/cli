import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Actions inherited from a generic base controller, served by each subclass
 * (real-repo FP: 35 GET-by-id routes stopped at the base's abstract call).
 */
const FILES: Record<string, string> = {
  "League.Api/League.Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
  "League.Api/RestController.cs": `using Microsoft.AspNetCore.Mvc;

namespace League.Api
{
    [ApiController]
    public abstract class RestController<TResource> : ControllerBase
    {
        [HttpGet("{id:int}")]
        public IActionResult GetResourceByIdWithErrorHandler(int id)
        {
            var resource = GetResourceById(id);
            return resource == null ? NotFound() : Ok(resource);
        }

        protected abstract TResource GetResourceById(int id);
    }
}
`,
  "League.Api/ClubController.cs": `using Microsoft.AspNetCore.Mvc;

namespace League.Api
{
    [Route("api/clubs")]
    public class ClubController : RestController<Club>
    {
        private readonly LeagueContext _db;

        public ClubController(LeagueContext db) { _db = db; }

        protected override Club GetResourceById(int id)
        {
            return _db.Clubs.Find(id);
        }
    }
}
`,
  "League.Api/PlayerController.cs": `using Microsoft.AspNetCore.Mvc;

namespace League.Api
{
    [Route("api/players")]
    public class PlayerController : RestController<Player>
    {
        private readonly LeagueContext _db;

        public PlayerController(LeagueContext db) { _db = db; }

        protected override Player GetResourceById(int id)
        {
            return _db.Players.Find(id);
        }
    }
}
`,
  "League.Api/LeagueContext.cs": `using Microsoft.EntityFrameworkCore;

namespace League.Api
{
    public class LeagueContext : DbContext
    {
        public DbSet<Club> Clubs { get; set; }
        public DbSet<Player> Players { get; set; }
    }

    public class Club { public int Id { get; set; } }
    public class Player { public int Id { get; set; } }
}
`,
};

describe("routes served by a subclass through a base-class action", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-route-override-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reach their own subclass's override, never a sibling's", () => {
    const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route").map((f) => `${f.entryLabel} ${f.resource}`).sort();
    expect(flows).toEqual(["GET /api/clubs/{id} Club", "GET /api/players/{id} Player"]);
  });
});
