import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { projectFileUsings } from "./package-manifests.js";

/**
 * A type name two namespaces declare (`League.Core.Rules.Fixture`,
 * `League.Core.Other.Fixture`) means the one the compiler finds from the
 * caller: its own namespace, then each enclosing one, then its usings — the
 * file's, a `global using` anywhere in its project, MSBuild `<Using>` items.
 */
const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`;
const FILES: Record<string, string> = {
  "League.Core/League.Core.csproj": CSPROJ,
  "League.Core/Rules/Fixture.cs": `namespace League.Core.Rules;
public class Fixture
{
    public Fixture(int round) {}
    public void Schedule() {}
}
`,
  "League.Core/Other/Fixture.cs": `namespace League.Core.Other;
public class Fixture
{
    public Fixture(int round) {}
    public void Schedule() {}
}
`,
  "League.Core/Rules/Ground.cs": `namespace League.Core.Rules;
public class Ground
{
    public void Prepare() { var f = new Fixture(3); f.Schedule(); }
}
`,
  "League.Core/Rules/Web/Booker.cs": `namespace League.Core.Rules.Web;
public class Booker
{
    public void Book() { var f = new Fixture(1); f.Schedule(); }
}
`,
  "League.Api/League.Api.csproj": CSPROJ,
  "League.Api/Usings.cs": `global using League.Core.Other;
`,
  "League.Api/Scheduler.cs": `namespace League.Api;
public class Scheduler
{
    public void Plan() { var f = new Fixture(3); f.Schedule(); }
}
`,
  "League.Web/League.Web.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Using Include="League.Core.Other" /></ItemGroup></Project>`,
  "League.Web/Planner.cs": `namespace League.Web;
public class Planner
{
    public void Plan() { var f = new Fixture(2); f.Schedule(); }
}
`,
  "League.Cup/League.Cup.csproj": CSPROJ,
  "League.Cup/Draw.cs": `using League.Core.Rules;
using League.Core.Other;
namespace League.Cup;
public class Draw
{
    public void Run() { var f = new Fixture(1); f.Schedule(); }
}
`,
};

describe("C# type lookup by namespace and usings", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cs-namespaces-"));
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

  const linksFrom = (file: string) => (summary.symbolLinks ?? [])
    .filter((l) => l.sourceFile === file && /Fixture|Schedule/.test(l.callName ?? ""))
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`).sort();

  it("finds the type in the caller's own namespace", () => {
    expect(linksFrom("League.Core/Rules/Ground.cs")).toEqual([
      "f.Schedule -> League.Core/Rules/Fixture.cs::Fixture.Schedule",
      "new Fixture -> League.Core/Rules/Fixture.cs::Fixture.Fixture",
    ]);
  });

  it("finds it in an enclosing namespace", () => {
    expect(linksFrom("League.Core/Rules/Web/Booker.cs")).toEqual([
      "f.Schedule -> League.Core/Rules/Fixture.cs::Fixture.Schedule",
      "new Fixture -> League.Core/Rules/Fixture.cs::Fixture.Fixture",
    ]);
  });

  it("finds it through a global using another file of the project declares", () => {
    expect(linksFrom("League.Api/Scheduler.cs")).toEqual([
      "f.Schedule -> League.Core/Other/Fixture.cs::Fixture.Schedule",
      "new Fixture -> League.Core/Other/Fixture.cs::Fixture.Fixture",
    ]);
  });

  it("finds it through an MSBuild <Using> of the project file", () => {
    expect(summary.subProjects?.find((p) => p.root === "League.Web")?.implicitImports).toEqual(["League.Core.Other"]);
    expect(linksFrom("League.Web/Planner.cs")).toEqual([
      "f.Schedule -> League.Core/Other/Fixture.cs::Fixture.Schedule",
      "new Fixture -> League.Core/Other/Fixture.cs::Fixture.Fixture",
    ]);
  });

  it("links neither when two imported namespaces declare it", () => {
    expect(linksFrom("League.Cup/Draw.cs")).toEqual([]);
  });
});

describe("MSBuild <Using> items", () => {
  const ctx = (props: string | null) => ({
    fileName: "League.Web.csproj",
    dirName: "League.Web",
    readSibling: async (name: string) => (name === "Directory.Build.props" ? props : null),
    readAncestors: async () => [],
  });

  it("reads the project's usings and those of Directory.Build.props, a static one is a using static of that type, never an alias", async () => {
    const proj = `<Project><ItemGroup>
  <Using Include="League.Clubs" />
  <Using Include="League.Clubs.Models" Alias="Models" />
  <Using Include="League.Scoring" Static="true" />
  <Using Remove="System.Net.Http" />
</ItemGroup></Project>`;
    expect(await projectFileUsings(proj, ctx(`<Project><ItemGroup><Using Include="League.Shared"/></ItemGroup></Project>`))).toEqual(["League.Shared", "League.Clubs", "League.Scoring"]);
  });
});

describe("MSBuild implicit usings", () => {
  const ctx = (props: string | null) => ({
    fileName: "League.Web.csproj",
    dirName: "League.Web",
    readSibling: async (name: string) => (name === "Directory.Build.props" ? props : null),
    readAncestors: async () => [],
  });
  const on = `<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>`;

  it("adds the Web SDK's global usings when ImplicitUsings is enabled, in the project or its props", async () => {
    const own = await projectFileUsings(`<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><ImplicitUsings>true</ImplicitUsings></PropertyGroup></Project>`, ctx(null));
    expect(own).toContain("Microsoft.Extensions.Hosting");
    expect(own).toContain("System.Linq");
    expect(await projectFileUsings(`<Project Sdk="Microsoft.NET.Sdk.Web/9.0.0"></Project>`, ctx(on))).toEqual(own);
  });

  it("gives the base SDK only the System namespaces and the Worker SDK the hosting ones", async () => {
    const base = await projectFileUsings(`<Project Sdk="Microsoft.NET.Sdk"></Project>`, ctx(on));
    expect(base).toContain("System.Threading.Tasks");
    expect(base).not.toContain("Microsoft.Extensions.Hosting");
    const worker = await projectFileUsings(`<Project Sdk="Microsoft.NET.Sdk.Worker"></Project>`, ctx(on));
    expect(worker).toContain("Microsoft.Extensions.Hosting");
    expect(worker).not.toContain("Microsoft.AspNetCore.Http");
  });

  it("adds nothing when disabled, unset, or the project's own value says no", async () => {
    expect(await projectFileUsings(`<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`, ctx(null))).toEqual([]);
    expect(await projectFileUsings(`<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>`, ctx(on))).toEqual([]);
  });

  it("ignores a conditional value and takes the last unconditional one", async () => {
    const web = (body: string) => `<Project Sdk="Microsoft.NET.Sdk.Web">${body}</Project>`;
    expect(await projectFileUsings(web(`<PropertyGroup Condition="'$(Configuration)'=='Debug'"><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>`), ctx(null))).toEqual([]);
    const later = await projectFileUsings(web(`<PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup>`), ctx(null));
    expect(later).toEqual([]);
  });

  it("applies <Using Include> and <Using Remove> over the SDK's list", async () => {
    const out = await projectFileUsings(
      `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Using Include="League.Clubs" /><Using Remove="System.Net.Http" /></ItemGroup></Project>`,
      ctx(on),
    );
    expect(out).toContain("League.Clubs");
    expect(out).not.toContain("System.Net.Http");
    expect(out).toContain("System.IO");
  });
});

describe("Blazor WebAssembly implicit usings", () => {
  it("adds only what the SDK's props add: configuration, injection and logging beside the base list", async () => {
    const ctx = { fileName: "League.Wasm.csproj", dirName: "League.Wasm", readSibling: async () => null, readAncestors: async () => [] };
    const usings = await projectFileUsings(`<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>`, ctx);
    expect(usings).toContain("Microsoft.Extensions.Logging");
    expect(usings).toContain("System.Linq");
    expect(usings).not.toContain("Microsoft.AspNetCore.Components.Web");
    expect(usings).not.toContain("System.Net.Http.Json");
    expect(usings).not.toContain("Microsoft.JSInterop");
  });
});
