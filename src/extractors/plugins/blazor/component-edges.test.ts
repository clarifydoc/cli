import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const FILES: Record<string, string> = {
  "Bz.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n`,
  "Services/ClubService.cs": `namespace League.Services;
public class ClubService {
  private readonly HttpClient _http;
  public ClubService(HttpClient http) { _http = http; }
  public async Task Load() { await _http.GetAsync("/api/clubs"); }
}
public class CarService {
  public Task Load() => Task.CompletedTask;
}
`,
  "Components/ClubCard.razor": `<div class="card"><button @onclick="OnRemove">Remove</button></div>
@code {
  [Parameter] public EventCallback OnRemove { get; set; }
}
`,
  "Pages/Clubs.razor": `@page "/clubs"
@inject ClubService Clubs
<h1>Clubs</h1>
<ClubCard />
<button @onclick="() => Clubs.Load()">Load</button>
`,
};

describe("Blazor tags and inline lambdas", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-blazor-edges-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("joins a `<ClubCard />` tag to its component file in the component graph", () => {
    expect(summary.componentGraph["Pages/Clubs.razor"]).toContain("Components/ClubCard.razor");
  });

  it("reaches `Load` on the injected type, not the namesake on another service", () => {
    const links = summary.symbolLinks.filter((l) => l.callName === "Clubs.Load");
    expect(links.map((l) => `${l.sourceFile} -> ${l.targetFile}`)).toEqual(["Pages/Clubs.razor -> Services/ClubService.cs"]);
  });
});
