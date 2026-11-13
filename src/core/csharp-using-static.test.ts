import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** An extension method in a NESTED static class is in scope through `using static` of that nested type, however it is spelled. */
const caller = (ns: string, using: string) => `${using}
namespace ${ns};

public class Desk
{
    public void Run(League.Outer.Club club)
    {
        club.Boost();
    }
}
`;

const FILES: Record<string, string> = {
  "Lib/Lib.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "Lib/Extensions.cs": `namespace League.Outer;

public class Club { }

public static class Outer
{
    public static class Inner
    {
        public static int Boost(this Club club) => 1;
    }
}
`,
  "Plain/Plain.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "Plain/Desk.cs": caller("League.Plain", "using static League.Outer.Outer.Inner;"),
  "Global/Global.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "Global/Desk.cs": caller("League.Global", "using static global::League.Outer.Outer.Inner;"),
  "Spaced/Spaced.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "Spaced/Desk.cs": caller("League.Spaced", "using static League.Outer . Outer.Inner;"),
  "None/None.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "None/Desk.cs": caller("League.None", ""),
  "Msbuild/Msbuild.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Using Include="League.Outer.Outer.Inner" Static="true" /></ItemGroup></Project>\n`,
  "Msbuild/Desk.cs": caller("League.Msbuild", ""),
};

describe("C# using static of a nested class", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-csharp-static-"));
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
    summary.symbolLinks.some((l) => l.sourceFile === `${project}/Desk.cs` && l.callName.endsWith("Boost") && l.targetFile === "Lib/Extensions.cs");

  it("links through `using static` of the nested class", () => expect(linked("Plain")).toBe(true));
  it("links through a `global::` prefixed `using static`", () => expect(linked("Global")).toBe(true));
  it("links through a `using static` with spacing in the name", () => expect(linked("Spaced")).toBe(true));
  it("does not link through `using static` of the outer class only", () => expect(linked("None")).toBe(false));
  it("links through an MSBuild `<Using Include Static=\"true\">`", () => expect(linked("Msbuild")).toBe(true));
});
