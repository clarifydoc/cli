import { describe, it, expect } from "vitest";
import { csharpReachability } from "./reachability.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const analysis = (filePath: string, cls: Record<string, unknown>): FileAnalysis =>
  ({ filePath, classes: [{ extends: null, implements: [], decorators: [], methods: [], ...cls }], functions: [], routes: [] }) as unknown as FileAnalysis;
const none = new Set<string>();

describe("C# reachability — what PowerShell and the compiler load", () => {
  it("keeps cmdlets, source generators, analyzers and code fixes alive", async () => {
    const m = await csharpReachability.load({ projectRoot: "/nonexistent", roots: [], files: new Set<string>() });
    const passive = (a: FileAnalysis) => m.passiveReason!(a, a.filePath, none);
    expect(passive(analysis("GetFoo.cs", { name: "GetFooCommand", extends: "PSCmdlet", decorators: ['Cmdlet(VerbsCommon.Get, "Foo")'] }))).not.toBeNull();
    expect(passive(analysis("MyGen.cs", { name: "MyGen", extends: "IIncrementalGenerator", decorators: ["Generator"] }))).not.toBeNull();
    expect(passive(analysis("Fix.cs", { name: "Fix", extends: "CodeFixProvider" }))).not.toBeNull();
    expect(passive(analysis("Orphan.cs", { name: "OrphanBall" }))).toBeNull();
  });

  it("keeps MassTransit and NServiceBus consumers, activities, sagas and features alive", async () => {
    const m = await csharpReachability.load({ projectRoot: "/nonexistent", roots: [], files: new Set<string>() });
    const passive = (a: FileAnalysis) => m.passiveReason!(a, a.filePath, none);
    expect(passive(analysis("TransferJob.cs", { name: "TransferJobConsumer", implements: ["IJobConsumer<TransferPlayer>"] }))).not.toBeNull();
    expect(passive(analysis("TransferDef.cs", { name: "TransferConsumerDefinition", extends: "ConsumerDefinition<TransferConsumer>" }))).not.toBeNull();
    expect(passive(analysis("MatchState.cs", { name: "MatchStateMachine", extends: "MassTransitStateMachine<MatchState>" }))).not.toBeNull();
    expect(passive(analysis("SignPlayer.cs", { name: "SignPlayerSaga", extends: "Saga<SignPlayerData>", implements: ["IAmStartedByMessages<OfferMade>", "IHandleTimeouts<OfferExpired>"] }))).not.toBeNull();
    expect(passive(analysis("Scouting.cs", { name: "ScoutingFeature", extends: "Feature" }))).not.toBeNull();
  });
});

describe("C# reachability — a NuGet package's public types", () => {
  it("keeps the public types of a project packed on build alive, not those of an app", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const root = await mkdtemp(join(tmpdir(), "cd-nuget-"));
    try {
      await mkdir(join(root, "League.Api/Core"), { recursive: true });
      await mkdir(join(root, "League.App"), { recursive: true });
      await writeFile(join(root, "League.Api/League.Api.csproj"), "<Project><PropertyGroup><GeneratePackageOnBuild>True</GeneratePackageOnBuild></PropertyGroup></Project>");
      await writeFile(join(root, "League.App/League.App.csproj"), "<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>");
      const files = new Set(["League.Api/League.Api.csproj", "League.App/League.App.csproj", "League.Api/Core/ResultInfo.cs", "League.App/Orphan.cs"]);
      const m = await csharpReachability.load({ projectRoot: root, roots: ["League.Api", "League.App"], files });
      const passive = (a: FileAnalysis) => m.passiveReason!(a, a.filePath, none);
      expect(passive(analysis("League.Api/Core/ResultInfo.cs", { name: "ResultInfo", isExported: true }))).toBe("NuGet package (public API)");
      expect(passive(analysis("League.App/Orphan.cs", { name: "Orphan", isExported: true }))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
