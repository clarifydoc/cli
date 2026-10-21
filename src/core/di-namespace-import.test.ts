import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Two services declare an interface of the same name; the one registration
 * names it through a namespace import (real-repo FP: the binding was refused).
 */
const csproj = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`;
const FILES: Record<string, string> = {
  "League.Application/League.Application.csproj": csproj,
  "League.Application/Interfaces/IClubRepository.cs": `namespace League.Application.Interfaces;

public interface IClubRepository { Task AddAsync(string name); }
`,
  "League.Application/Clubs/ClubService.cs": `using League.Application.Interfaces;

namespace League.Application.Clubs;

public class ClubService
{
    private readonly IClubRepository _clubs;

    public ClubService(IClubRepository clubs) { _clubs = clubs; }

    public Task Register(string name) => _clubs.AddAsync(name);
}
`,
  "League.Application/Clubs/ClubQueries.cs": `using LocalClubs = League.Application.Interfaces.IClubRepository;

namespace League.Application.Clubs;

public class ClubQueries
{
    private readonly LocalClubs _clubs;

    public ClubQueries(LocalClubs clubs) { _clubs = clubs; }

    public Task Rename(string name) => _clubs.AddAsync(name);
}
`,
  "League.Infrastructure/League.Infrastructure.csproj": csproj,
  "League.Infrastructure/ClubRepository.cs": `using League.Application.Interfaces;

namespace League.Infrastructure;

public class ClubRepository : IClubRepository
{
    public Task AddAsync(string name) => Task.CompletedTask;
}
`,
  "League.Infrastructure/DependencyInjection.cs": `using League.Application.Interfaces;
using Microsoft.Extensions.DependencyInjection;

namespace League.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services)
    {
        services.AddScoped<IClubRepository, ClubRepository>();
        return services;
    }
}
`,
  "Cup.Application/Cup.Application.csproj": csproj,
  "Cup.Application/Interfaces/IClubRepository.cs": `namespace Cup.Application.Interfaces;

public interface IClubRepository { Task AddAsync(string name); }
`,
};

describe("a registration naming its service through a namespace import", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-di-namespace-"));
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

  it("binds the interface of the namespace it imports", () => {
    const targets = summary.symbolLinks.filter((l) => l.sourceSymbol === "ClubService.Register").map((l) => `${l.targetSymbol} ${l.strategy}`);
    expect(targets).toContain("ClubRepository.AddAsync di-binding");
  });

  it("reads a member typed by a using alias as the type the alias names", () => {
    const targets = summary.symbolLinks.filter((l) => l.sourceSymbol === "ClubQueries.Rename").map((l) => `${l.targetSymbol} ${l.strategy}`);
    expect(targets).toContain("ClubRepository.AddAsync di-binding");
  });
});
