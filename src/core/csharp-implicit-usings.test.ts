import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * The .NET SDK's implicit global usings (`<ImplicitUsings>`) put namespaces such as
 * `Microsoft.Extensions.Hosting` in scope of every file of a project, so an extension class declared
 * there is called without a `using`. Sibling projects share the extension; each has one caller.
 */
const EXTENSION = `namespace Microsoft.Extensions.Hosting;

public static class BusExtensions
{
    public static IHostApplicationBuilder AddBusTransport(this IHostApplicationBuilder b) => b;
}
`;

const caller = (ns: string) => `namespace ${ns};

public class Startup
{
    public void Run(IHostApplicationBuilder builder)
    {
        builder.AddBusTransport();
    }
}
`;

const FILES: Record<string, string> = {
  "Directory.Build.props": `<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>\n`,
  "Shared/Shared.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "Shared/BusExtensions.cs": EXTENSION,
  // Web SDK, ImplicitUsings from the props file.
  "Web/Web.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n`,
  "Web/Startup.cs": caller("League.Web"),
  // The project's own value wins over the props file.
  "Off/Off.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>\n`,
  "Off/Startup.cs": caller("League.Off"),
  // The base SDK has no hosting namespace.
  "Plain/Plain.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "Plain/Startup.cs": caller("League.Plain"),
  // A Worker project that removes the namespace again.
  "Removed/Removed.csproj": `<Project Sdk="Microsoft.NET.Sdk.Worker"><ItemGroup><Using Remove="Microsoft.Extensions.Hosting" /></ItemGroup></Project>\n`,
  "Removed/Startup.cs": caller("League.Removed"),
  // A base SDK project that adds it.
  "Added/Added.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Using Include="Microsoft.Extensions.Hosting" /></ItemGroup></Project>\n`,
  "Added/Startup.cs": caller("League.Added"),
};

describe("C# implicit usings", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-csharp-implicit-"));
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

  const linked = (project: string) =>
    summary.symbolLinks.some((l) => l.sourceFile === `${project}/Startup.cs` && l.callName.endsWith("AddBusTransport") && l.targetFile === "Shared/BusExtensions.cs");

  it("links an extension of an implicitly imported namespace (Web SDK, ImplicitUsings enabled in the props)", () => {
    expect(linked("Web")).toBe(true);
  });

  it("does not link when the project disables ImplicitUsings itself", () => {
    expect(linked("Off")).toBe(false);
  });

  it("does not link when the SDK's list lacks the namespace", () => {
    expect(linked("Plain")).toBe(false);
  });

  it("does not link a namespace a <Using Remove> takes away", () => {
    expect(linked("Removed")).toBe(false);
  });

  it("links a namespace a <Using Include> adds", () => {
    expect(linked("Added")).toBe(true);
  });
});
