import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** Two `Parts` classes in different namespaces: a `using` picks one, an import naming a namespace the project lacks picks none. */
const FILES: Record<string, string> = {
  "Cars.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "Parts.cs": `namespace League.Tools { public static class Parts { public static int Tune(int x) { return x; } } }\n`,
  "Decoy.cs": `namespace Garage.Other { public static class Parts { public static int Tune(int x) { return x + 1; } public static int Wash() { return 0; } } }\n`,
  "Static.cs": `using static League.Tools.Parts;\nnamespace App { public class Mechanic { public int Go() { return Tune(3); } } }\n`,
  "Missing.cs": `using static Missing.Ns.Parts;\nnamespace App { public class Lost { public int Go() { return Tune(3); } public int Q() { return Parts.Wash(); } } }\n`,
  "Qualified.cs": `using League.Tools;\nnamespace App { public class Qualified { public int Go() { return Parts.Tune(3); } } }\n`,
  "Nothing.cs": `namespace App { public class Nothing { public int Go() { return Parts.Tune(3); } } }\n`,
};

describe("C# namesake classes in different namespaces", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-csharp-namesake-"));
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

  const targets = (file: string) => summary.symbolLinks.filter((l) => l.sourceFile === file).map((l) => `${l.targetFile}::${l.targetSymbol}`);

  it("`using static` of a namespace links its own class", () => expect(targets("Static.cs")).toEqual(["Parts.cs::Parts.Tune"]));
  it("`using static` of a namespace the project lacks links no namesake", () => expect(targets("Missing.cs")).toEqual([]));
  it("a qualified `Parts.Tune()` is the class of the namespace the file imports", () => expect(targets("Qualified.cs")).toEqual(["Parts.cs::Parts.Tune"]));
  it("a qualified call no import or namespace decides links no namesake", () => expect(targets("Nothing.cs")).toEqual([]));
});
