import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Three more shapes of a C# class lookup that must keep linking when namespaces share names:
 * a partly qualified class (`Lineup.Scout.X()`) in a file that also imports a namespace called `Scout`,
 * a class whose name is also a member name in other files, and a class two imported namespaces declare
 * (one by a `global using`), where only one of them declares the called member.
 */
const PROJECT = `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`;
const REFERENCING = (to: string) => `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="..\\${to}\\${to}.csproj" /></ItemGroup></Project>\n`;
const FILES: Record<string, string> = {
  // 1: partly qualified, file-scoped namespaces, a namespace import named like the class.
  "Lib/Lib.csproj": PROJECT,
  "Lib/Lineup/Scout.cs": `namespace League.Services.Lineup;\npublic static partial class Scout { public static bool IsDefaultKit(int x) { return x > 0; } public static bool IsLoose(int x) { return x < 0; } }\n`,
  "Lib/Models/Scout/Squad.cs": `namespace League.Models.Scout;\npublic class Squad { public int N; }\n`,
  "Lib/Extensions/SquadExtensions.cs": `using League.Models.Scout;\n\nnamespace League.Services.Extensions;\n\npublic static class SquadExtensions {\n  public static bool Merge(this Squad s, int x) { return x > 0 || (Lineup.Scout.IsDefaultKit(x) && Lineup.Scout.IsLoose(x)); }\n  public static string Pick(this Squad s) { return Lineup.Scout.IsDefaultKit(s.N) ? "a" : "b"; }\n}\n`,
  // 2: a project of its own, a test class naming a method like the class.
  "Data/Data.csproj": PROJECT,
  "Data/Garage.cs": `namespace League.Data;\npublic static class Garage { public static int Fill(int a) { return a; } public static int Wash() { return 1; } }\n`,
  "Tests/Tests.csproj": REFERENCING("Data"),
  "Tests/Cache/Fake.cs": `namespace League.Tests.Cache;\npublic class Fake { public void Garage<T>(string key, T value) { } }\n`,
  "Tests/Info/InfoTests.cs": `using System.Threading.Tasks;\nnamespace League.Tests.Scrub;\npublic class InfoTests { private async Task Run() { await Garage(null, "k"); } private static async Task Garage(object c, string k) { await Task.CompletedTask; } }\n`,
  "Tests/Scrub/ScrubTests.cs": `using System.Threading.Tasks;\nusing League.Data;\nnamespace League.Tests.Scrub;\npublic class ScrubTests { private async Task Fill() { await Garage.Fill(3); await Garage.Wash(); } }\n`,
  // 3: two imported namespaces (one global) declare Ticket; the member decides; a third, out of scope, declares it too.
  "Api/Api.csproj": REFERENCING("Domain"),
  "Domain/Domain.csproj": PROJECT,
  "Client/Client.csproj": PROJECT,
  "Api/GlobalUsings.cs": `global using Shop.Booking.API.Application.Queries;\nglobal using Shop.Booking.Domain.Model.TicketAggregate;\n`,
  "Api/Application/Queries/TicketView.cs": `namespace Shop.Booking.API.Application.Queries;\npublic record Ticket { public int Total { get; init; } }\n`,
  "Domain/Model/TicketAggregate/Ticket.cs": `namespace Shop.Booking.Domain.Model.TicketAggregate;\npublic class Ticket { public static Ticket Open() { return new Ticket(); } }\n`,
  "Client/Models/Ticket.cs": `namespace Shop.Client.Models.Tickets { public class Ticket { public static Ticket Open() { return new Ticket(); } public static int OnlyHere() { return 1; } } }\n`,
  "Api/Application/Commands/Handler.cs": `using Shop.Booking.Domain.Model.TicketAggregate;\nnamespace Shop.Booking.API.Application.Commands;\npublic class Handler { public object Handle() { return Ticket.Open(); } public int Total() { return Ticket.OnlyHere() + Ticket.Missing(); } }\n`,
};

describe("C# lookups through shared namespace names", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-csharp-nsshare-"));
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

  it("`Lineup.Scout.X()` links when the file also imports a namespace named `Scout`", () => {
    const t = targets("Lib/Extensions/SquadExtensions.cs");
    expect(t).toContain("Lineup.Scout.IsDefaultKit -> Lib/Lineup/Scout.cs::Scout.IsDefaultKit");
    expect(t).toContain("Lineup.Scout.IsLoose -> Lib/Lineup/Scout.cs::Scout.IsLoose");
  });
  it("a method named like the class in other files is no namesake class", () => {
    expect(targets("Tests/Scrub/ScrubTests.cs")).toEqual(["Garage.Fill -> Data/Garage.cs::Garage.Fill", "Garage.Wash -> Data/Garage.cs::Garage.Wash"]);
  });
  it("two imported namespaces declaring the class: the one that declares the member", () => {
    expect(targets("Api/Application/Commands/Handler.cs").filter((t) => t.startsWith("Ticket.Open"))).toEqual(["Ticket.Open -> Domain/Model/TicketAggregate/Ticket.cs::Ticket.Open"]);
  });
  it("a member only an out-of-scope namesake declares, or nobody, links nothing", () => {
    expect(targets("Api/Application/Commands/Handler.cs").filter((t) => !t.startsWith("Ticket.Open"))).toEqual([]);
  });
});
