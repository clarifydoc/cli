import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A project-wide `using static` — a build's `<Using Include="League.Tools.Parts" Static="true" />` or a
 * `global using static` in any file — puts the static members of that class in scope of every file of the
 * project, as the file-level `using static` does: a bare `Wheel()` is that class's, never a namesake's.
 */
const FILES: Record<string, string> = {
  "League.csproj": `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>\n  <ItemGroup>\n    <Using Include="League.Tools.Parts" Static="true" />\n  </ItemGroup>\n</Project>\n`,
  "Parts.cs": `namespace League.Tools\n{\n    public static class Parts\n    {\n        public static int Wheel() => 1;\n    }\n}\n`,
  "Spares.cs": `namespace League.Other\n{\n    public static class Spares\n    {\n        public static int Brake() => 3;\n    }\n}\n`,
  // a namesake of the class the build names, in a namespace nothing imports
  "Decoy.cs": `namespace League.Elsewhere\n{\n    public static class Parts\n    {\n        public static int Wheel() => 2;\n    }\n}\n`,
  "Shared.cs": `global using static League.Other.Spares;\n`,
  "Garage.cs": `namespace League.Garage\n{\n    public class Shop\n    {\n        public int Fit() { return Wheel(); }\n        public int Stop() { return Brake(); }\n    }\n}\n`,
};

describe("C# project-wide using static", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cs-static-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const targets = (symbol: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.relation !== "reference").map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);

  it("a bare call finds the member of the class a project-level using static names, not a namesake's", () => {
    expect(targets("Shop.Fit")).toEqual(["Wheel -> Parts.cs::Parts.Wheel"]);
  });

  it("a `global using static` of any file reaches every file of the project", () => {
    expect(targets("Shop.Stop")).toEqual(["Brake -> Spares.cs::Spares.Brake"]);
  });
});
