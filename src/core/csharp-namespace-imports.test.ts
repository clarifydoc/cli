import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A C# `using` names a namespace, which files of any project or directory
 * declare. An extension method in a namespace the caller imports is
 * evidenced, so is a static helper of another project's namespace; a method of a
 * namespace the caller does not import stays unlinked — a builtin `Contains`
 * never lands on the project's only `Contains` (real-repo shape).
 */
const FILES: Record<string, string> = {
  "League.Core/League.Core.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "League.Api/Extensions/ClubQueryExtensions.cs": `namespace League.Api.Extensions;

public static class ClubQueryExtensions
{
    public static IQueryable<Club> WhereTopFlight(this IQueryable<Club> clubs) => clubs;
}
`,
  "League.Api/Scoring/GoalSet.cs": `namespace League.Api.Scoring
{
    public class GoalSet
    {
        public bool Contains(int minute) => true;
    }
}
`,
  "League.Core/Helpers/TableHelper.cs": `namespace League.Core.Helpers;

public static class TableHelper
{
    public static int Points(int wins) => wins * 3;
}
`,
  "League.Api/League.Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n`,
  "League.Api/Services/StandingsService.cs": `using League.Api.Extensions;
using League.Core.Helpers;

namespace League.Api.Services;

public class StandingsService
{
    public int Load(List<int> ids)
    {
        var clubs = Store.Fetch();
        var top = clubs.WhereTopFlight();
        var points = TableHelper.Points(3);
        return ids.Contains(points) ? 1 : 0;
    }
}
`,
};

describe("C# namespace imports", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-csharp-namespaces-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName.endsWith(callName));
    return link ? `${link.targetFile} ${link.targetSymbol} ${link.strategy}` : null;
  };

  it("links an extension method of a namespace the caller imports", () => {
    expect(linkOf("StandingsService.Load", "clubs.WhereTopFlight")).toBe(
      "League.Api/Extensions/ClubQueryExtensions.cs ClubQueryExtensions.WhereTopFlight unique-global",
    );
  });

  it("links a static helper of another project's namespace the caller imports", () => {
    expect(linkOf("StandingsService.Load", "TableHelper.Points")).toBe("League.Core/Helpers/TableHelper.cs TableHelper.Points class-name");
  });

  it("leaves a builtin call sharing a name with a method of a namespace the caller does not import unlinked", () => {
    expect(linkOf("StandingsService.Load", "ids.Contains")).toBeNull();
  });
});
