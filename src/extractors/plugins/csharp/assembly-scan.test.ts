import { describe, it, expect } from "vitest";
import { CSharpAssemblyScanResolver, collectAssemblyScans, CS_ASSEMBLY_SCAN_FACT } from "./assembly-scan.js";
import type { ClassInfo, FileAnalysis, FunctionInfo, RouteFact } from "../../../types/analysis.js";

const method = (name: string, line: number): FunctionInfo => ({ name, line, endLine: line + 2, params: [], calls: [] }) as unknown as FunctionInfo;
const cls = (name: string, extendsText: string | null, methods: FunctionInfo[]): ClassInfo =>
  ({ name, kind: "class", extends: extendsText, implements: [], methods, properties: [], decorators: [], line: 1, endLine: 9 }) as unknown as ClassInfo;
const file = (filePath: string, projectId: string, classes: ClassInfo[], extra: Partial<FileAnalysis> = {}): FileAnalysis =>
  ({ filePath, projectId, language: "csharp", classes, functions: [], ...extra }) as unknown as FileAnalysis;

function registering(source: string, project = "league-api"): FileAnalysis {
  const facts: RouteFact[] = [];
  collectAssemblyScans(source, facts);
  return file("League.Api/Program.cs", project, [], {
    routeFacts: facts,
    functions: [{ name: "<setup>", line: 1, endLine: 1, params: [], calls: [] } as unknown as FunctionInfo],
  });
}

const handler = (n: string) => cls(`${n}Handler`, `IRequestHandler<${n}, int>`, [method("Handle", 5)]);

describe("collectAssemblyScans", () => {
  it("reads the marker types of each scanning registration", () => {
    const facts: RouteFact[] = [];
    collectAssemblyScans(
      `services.AddMediatR(cfg => cfg.RegisterServicesFromAssembly(typeof(Program).Assembly));
       // services.AddMediator();
       x.AddConsumersFromNamespaceContaining<ClubJoinedConsumer>();`,
      facts,
    );
    expect(facts.map((f) => [f.kind, (f.data as { family: string; markers: string[] }).family, (f.data as { markers: string[] }).markers])).toEqual([
      [CS_ASSEMBLY_SCAN_FACT, "mediatr", ["Program"]],
      [CS_ASSEMBLY_SCAN_FACT, "masstransit", ["ClubJoinedConsumer"]],
    ]);
  });
});

describe("CSharpAssemblyScanResolver", () => {
  it("links the registering function to the handlers of the scanned project only", () => {
    const reg = registering("services.AddMediatR(cfg => cfg.RegisterServicesFromAssembly(typeof(Program).Assembly));");
    const own = file("League.Api/Handlers.cs", "league-api", [handler("SignPlayer"), cls("NotAHandler", null, [method("Handle", 3)])]);
    const decoy = file("League.Other/Handlers.cs", "league-other", [handler("SignPlayer")]);
    const links = new CSharpAssemblyScanResolver().resolve([reg, own, decoy]);
    expect(links.map((l) => [l.sourceFile, l.sourceSymbol, l.targetFile, l.targetSymbol])).toEqual([
      ["League.Api/Program.cs", "<setup>", "League.Api/Handlers.cs", "SignPlayerHandler.Handle"],
    ]);
  });

  it("follows a marker type into the project that declares it, preferring the registering project's namesake", () => {
    const reg = registering("x.AddConsumers(typeof(ClubJoinedConsumer).Assembly);");
    const consumer = (project: string, path: string) =>
      file(path, project, [cls("ClubJoinedConsumer", "IConsumer<ClubJoined>", [method("Consume", 4)])]);
    const links = new CSharpAssemblyScanResolver().resolve([reg, consumer("league-api", "League.Api/C.cs"), consumer("league-other", "League.Other/C.cs")]);
    expect(links.map((l) => l.targetFile)).toEqual(["League.Api/C.cs"]);
  });

  it("scans the registering project for an NServiceBus endpoint and ignores a marker it cannot place", () => {
    const reg = registering(`var c = new EndpointConfiguration("club"); services.AddConsumers(typeof(External.Thing).Assembly);`);
    const h = file("League.Api/H.cs", "league-api", [cls("TrainingHandler", "IHandleMessages<Train>", [method("Handle", 2)])]);
    const links = new CSharpAssemblyScanResolver().resolve([reg, h]);
    expect(links.map((l) => l.targetSymbol)).toEqual(["TrainingHandler.Handle"]);
  });
});

describe("scan details", () => {
  it("takes only assembly markers, links every handler overload and keeps a namespace scan on its boundary", () => {
    const facts: RouteFact[] = [];
    collectAssemblyScans(`services.AddMediatR(cfg => { cfg.RegisterServicesFromAssembly(typeof(Program).Assembly); cfg.AddBehavior(typeof(AuditBehavior)); });`, facts);
    expect((facts[0]!.data as { markers: string[] }).markers).toEqual(["Program"]);

    const reg = registering(`new EndpointConfiguration("club");`);
    const multi = file("League.Api/H.cs", "league-api", [cls("TrainingHandler", "IHandleMessages<Train>", [method("Handle", 2), method("Handle", 6)])]);
    expect(new CSharpAssemblyScanResolver().resolve([reg, multi]).map((l) => l.targetLine)).toEqual([2, 6]);

    const ns = registering(`x.AddConsumersFromNamespaceContaining<ClubJoinedConsumer>();`);
    const consumer = (path: string, pkg: string, name: string) =>
      file(path, "league-api", [cls(name, "IConsumer<ClubJoined>", [method("Consume", 4)])], { packageName: pkg });
    const hits = new CSharpAssemblyScanResolver().resolve([
      ns,
      consumer("A.cs", "Club.Orders", "ClubJoinedConsumer"),
      consumer("B.cs", "Club.Orders.Sub", "SubConsumer"),
      consumer("C.cs", "Club.OrdersArchive", "ArchiveConsumer"),
    ]);
    expect(hits.map((l) => l.targetFile)).toEqual(["A.cs", "B.cs"]);
  });
});
