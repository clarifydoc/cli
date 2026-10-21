import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** A domain DTO sharing its name with the EF entity (real-repo FP: every table twice in the ER graph). */
const csproj = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`;
const FILES: Record<string, string> = {
  "League.Domain/League.Domain.csproj": csproj,
  "League.Domain/Entities/Club.cs": `namespace League.Domain.Entities;

[SwaggerSchema("A club, as the API shows it.")]
public class Club { public Guid ClubId { get; set; } public string Name { get; set; } }
`,
  "League.Infrastructure/League.Infrastructure.csproj": csproj,
  "League.Infrastructure/Entities/Club.cs": `namespace League.Infrastructure.Entities;

public class Club { public Guid ClubId { get; set; } public string Name { get; set; } }
`,
  "League.Infrastructure/Entities/Season.cs": `using System.ComponentModel.DataAnnotations.Schema;

namespace League.Infrastructure.Entities;

[Table("seasons")]
public class Season { public Guid SeasonId { get; set; } }
`,
  "League.Infrastructure/LeagueContext.cs": `using League.Infrastructure.Entities;
using Microsoft.EntityFrameworkCore;

namespace League.Infrastructure;

public class LeagueContext : DbContext
{
    public DbSet<Club> Clubs { get; set; }
}
`,
};

describe("EF entities named by a DbContext's sets", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ef-projects-"));
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

  it("are the classes of the context's own sub-project when several share the name", () => {
    const clubs = (summary.entityGraph?.nodes ?? []).filter((n) => n.name === "Club").map((n) => n.filePath);
    expect(clubs).toEqual(["League.Infrastructure/Entities/Club.cs"]);
  });
});
