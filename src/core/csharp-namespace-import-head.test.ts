import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A `using` whose last segment equals a class name names a NAMESPACE (`using League.Models.Scout;`), not that class:
 * the call's `target` then leads to no type's file, and the class is found by the compiler's lookup instead.
 */
const FILES: Record<string, string> = {
  "Cars.csproj": `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`,
  "Services/Lineup/Scout.cs": `namespace League.Services.Lineup { public static class Scout { public static bool IsHomeKit(string p) { return true; } public static bool IsDefaultKit() { return true; } } }\n`,
  "Models/Scout/Squad.cs": `namespace League.Models.Scout { public class Squad { public int N; } }\n`,
  "Services/KitService.cs": `using League.Models.Scout;\nusing League.Services.Lineup;\nnamespace League.Services { public class KitService { public bool Go(string p) { var x = Lineup.Scout.IsDefaultKit(); return Scout.IsHomeKit(p); } } }\n`,
  // The decoy: a Scout of a namespace nothing in Lost.cs reaches.
  "Other/Scout.cs": `namespace Garage.Other { public static class Scout { public static bool Wash() { return false; } } }\n`,
  "Services/Lost.cs": `using League.Models.Scout;\nnamespace League.Services { public class Lost { public bool Go() { return Scout.Wash(); } public bool Q() { return Lineup.Scout.IsHomeKit(""); } } }\n`,
  // A namespace called like a class, and a call whose generic argument is the only type it names.
  "Resources/Resources.cs": `namespace League.Resources { public class PagedList<T> { public int Total; } public class QueueEntry { public int N; } }\n`,
  "Queue/Entry.cs": `namespace League.Queue { public class Entry { } }\n`,
  "Queue/Queue.cs": `namespace League.Core { public class Queue { public int Size; } }\n`,
  "Api/Client.cs": `using League.Resources;\nusing League.Queue;\nnamespace League.Api { public class Client { public IQ Queue; public object Go() { return Queue.Get<PagedList<QueueEntry>>("x"); } } public interface IQ { T Get<T>(string s); } }\n`,
};

describe("C# namespace imports named like a class", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-csharp-nsimport-"));
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

  const targets = (file: string) => summary.symbolLinks.filter((l) => l.sourceFile === file && !l.callName.startsWith("new ")).map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`).sort();

  it("`Scout.IsHomeKit()` is the class a sibling `using` brings in, not the namespace the first `using` names", () => {
    expect(targets("Services/KitService.cs")).toContain("Scout.IsHomeKit -> Services/Lineup/Scout.cs::Scout.IsHomeKit");
  });
  it("`Lineup.Scout.X()` completes its namespace through the enclosing one", () => {
    expect(targets("Services/KitService.cs")).toContain("Lineup.Scout.IsDefaultKit -> Services/Lineup/Scout.cs::Scout.IsDefaultKit");
  });
  it("a namesake class of a namespace nothing reaches is never picked", () => {
    expect(targets("Services/Lost.cs").filter((t) => t.startsWith("Scout.Wash"))).toEqual([]);
  });
  it("a call that names a namespace-like head still links the type argument it carries", () => {
    expect(targets("Api/Client.cs")).toEqual(["Queue.Get<PagedList<QueueEntry>> -> Resources/Resources.cs::PagedList"]);
  });
});
