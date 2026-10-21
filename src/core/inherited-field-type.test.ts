import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A base command handler stores the repository its subclass hands to `base(…)`
 * (real-repo FP: seven create commands stopped at the generic `IRepository<T>`).
 */
const FILES: Record<string, string> = {
  "League/League.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
  "League/BaseCommandHandler.cs": `namespace League;

public interface IRepository<TEntity>
{
    Task<TEntity> AddAsync(TEntity entity);
}

public abstract class BaseCommandHandler<TCommand, TEntity>
{
    protected readonly IRepository<TEntity> _repository;

    protected BaseCommandHandler(IRepository<TEntity> repository)
    {
        _repository = repository;
    }

    public abstract Task<TEntity> Handle(TCommand request);
}
`,
  "League/CreateClubCommandHandler.cs": `namespace League;

public class CreateClubCommandHandler : BaseCommandHandler<CreateClubCommand, Club>
{
    public CreateClubCommandHandler(IClubRepository clubRepository)
        : base(clubRepository)
    {
    }

    public override async Task<Club> Handle(CreateClubCommand request)
    {
        return await _repository.AddAsync(request.Club);
    }
}

public record CreateClubCommand(Club Club);
`,
  "League/ClubRepository.cs": `namespace League;

public interface IClubRepository : IRepository<Club> { }

public class ClubRepository : IClubRepository
{
    private readonly LeagueContext _context;

    public ClubRepository(LeagueContext context) { _context = context; }

    public async Task<Club> AddAsync(Club club)
    {
        _context.Clubs.Add(club);
        await _context.SaveChangesAsync();
        return club;
    }
}
`,
  "League/LeagueContext.cs": `using Microsoft.EntityFrameworkCore;

namespace League;

public class LeagueContext : DbContext
{
    public DbSet<Club> Clubs { get; set; }
}

public class Club { public int Id { get; set; } }
`,
};

describe("a base-class field set from what the subclass hands to base(…)", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-inherited-field-"));
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

  it("has the subclass's declared type", () => {
    const targets = summary.symbolLinks.filter((l) => l.sourceSymbol === "CreateClubCommandHandler.Handle").map((l) => l.targetSymbol);
    expect(targets).toContain("ClubRepository.AddAsync");
    expect(targets).not.toContain("IRepository.AddAsync");
  });
});
