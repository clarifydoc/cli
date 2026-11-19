import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractFunctions, extractClasses } from "../../functions-classes/index.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { CSharpHangfireTriggerResolver, csharpHangfireArgs } from "./hangfire-triggers.js";
import { csharpCallHooks } from "./call-hooks.js";

async function analysisOf(filePath: string, src: string): Promise<FileAnalysis> {
  const tree = await parseSource(src, "csharp" as never, filePath);
  return {
    filePath,
    language: "csharp",
    projectId: "root",
    imports: [],
    exports: [],
    classes: extractClasses(tree, src, "csharp" as never),
    functions: extractFunctions(tree, src, "csharp" as never),
    routes: [],
    dataSources: [],
  } as unknown as FileAnalysis;
}

const SCHEDULER = `namespace League;
public class Scheduler {
  public const string BackupId = "backup";
  public const string ReportId = "report";
  public void Schedule() {
    RecurringJob.AddOrUpdate<IBackupService>(BackupId, s => s.Run(CancellationToken.None), Cron.Daily);
    RecurringJob.AddOrUpdate<IReportService>(ReportId, s => s.Run(CancellationToken.None), Cron.Weekly);
    RecurringJob.AddOrUpdate("sweep", () => Sweep(), Cron.Hourly);
  }
  public void Sweep() { }
}
public interface IBackupService { void Run(CancellationToken ct); }
public interface IReportService { void Run(CancellationToken ct); }
public class BackupService : IBackupService { public void Run(CancellationToken ct) { } }
public class ReportService : IReportService { public void Run(CancellationToken ct) { } }
`;

const CONTROLLER = `namespace League;
public class ServerController {
  public void Backup() { RecurringJob.TriggerJob(Scheduler.BackupId); }
  public void Sweep() { RecurringJob.TriggerJob("sweep"); }
  public void Missing() { RecurringJob.TriggerJob("nothing"); }
  public void Other() { jobs.TriggerJob(Scheduler.BackupId); }
}
`;

describe("Hangfire recurring jobs triggered by id", () => {
  it("states the arguments of a registration and of a trigger", async () => {
    const tree = await parseSource(`class A { void M() {
  RecurringJob.AddOrUpdate<IBackupService>(BackupId, s => s.Run(ct), Cron.Daily);
  RecurringJob.TriggerJob("x");
  RecurringJob.AddOrUpdate<A, B>("y", s => s.Run(), Cron.Daily);
  other.TriggerJob("z");
} }`, "csharp" as never, "A.cs");
    const out = tree.rootNode.descendantsOfType("invocation_expression").filter((n) => /^(?:RecurringJob|other)\./.test(n!.text)).map((n) => csharpHangfireArgs(n!));
    expect(out).toEqual([["BackupId", "IBackupService", "Run"], ["\"x\""], null, null]);
    expect(csharpCallHooks.argsOf).toBeTypeOf("function");
  });

  it("links the function that triggers a job to the methods its registration runs, and nothing else", async () => {
    const files = [await analysisOf("Scheduler.cs", SCHEDULER), await analysisOf("ServerController.cs", CONTROLLER)];
    // `args` as the plugin's hook states them, which the call extractor copies onto the calls.
    const withArgs = async (a: FileAnalysis, src: string) => {
      const tree = await parseSource(src, "csharp" as never, a.filePath);
      const argsByLine = new Map<number, string[]>();
      for (const n of tree.rootNode.descendantsOfType("invocation_expression")) {
        const args = csharpHangfireArgs(n!);
        if (args) argsByLine.set(n!.startPosition.row + 1, args);
      }
      for (const fn of [...a.functions, ...a.classes.flatMap((c) => c.methods)]) for (const c of fn.calls) if (argsByLine.has(c.line) && /RecurringJob\./.test(c.name)) c.args = argsByLine.get(c.line)!;
    };
    await withArgs(files[0]!, SCHEDULER);
    await withArgs(files[1]!, CONTROLLER);
    const links = new CSharpHangfireTriggerResolver().resolve(files).map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`).sort();
    expect(links).toEqual(["ServerController.Backup -> BackupService.Run", "ServerController.Sweep -> Scheduler.Sweep"]);
  });

  it("caps interface fan-out at one implementer — a decoy implementer is not linked", async () => {
    const schedule = `namespace League;
public class FixtureScheduler {
  public const string RefreshStandingsId = "refresh-standings";
  public void Schedule() {
    RecurringJob.AddOrUpdate<IStandingsService>(RefreshStandingsId, s => s.RefreshStandings(), Cron.Daily);
  }
}
public interface IStandingsService { void RefreshStandings(); }
public class StandingsService : IStandingsService { public void RefreshStandings() { } }
public class DecoyStandingsService : IStandingsService { public void RefreshStandings() { } }
`;
    const trigger = `namespace League;
public class FixtureController {
  public void RefreshNow() { RecurringJob.TriggerJob(FixtureScheduler.RefreshStandingsId); }
}
`;
    const unique = `namespace Garage;
public class FleetScheduler {
  public const string ServiceId = "service-fleet";
  public void Schedule() {
    RecurringJob.AddOrUpdate<IFleetService>(ServiceId, s => s.ServiceFleet(), Cron.Daily);
  }
}
public interface IFleetService { void ServiceFleet(); }
public class FleetService : IFleetService { public void ServiceFleet() { } }
`;
    const uniqueTrigger = `namespace Garage;
public class FleetController {
  public void ServiceNow() { RecurringJob.TriggerJob(FleetScheduler.ServiceId); }
}
`;
    const withArgs = async (a: FileAnalysis, src: string) => {
      const tree = await parseSource(src, "csharp" as never, a.filePath);
      const argsByLine = new Map<number, string[]>();
      for (const n of tree.rootNode.descendantsOfType("invocation_expression")) {
        const args = csharpHangfireArgs(n!);
        if (args) argsByLine.set(n!.startPosition.row + 1, args);
      }
      for (const fn of [...a.functions, ...a.classes.flatMap((c) => c.methods)]) for (const c of fn.calls) if (argsByLine.has(c.line) && /RecurringJob\./.test(c.name)) c.args = argsByLine.get(c.line)!;
    };
    const multi = [await analysisOf("FixtureScheduler.cs", schedule), await analysisOf("FixtureController.cs", trigger)];
    await withArgs(multi[0]!, schedule);
    await withArgs(multi[1]!, trigger);
    expect(new CSharpHangfireTriggerResolver().resolve(multi)).toEqual([]);

    const one = [await analysisOf("FleetScheduler.cs", unique), await analysisOf("FleetController.cs", uniqueTrigger)];
    await withArgs(one[0]!, unique);
    await withArgs(one[1]!, uniqueTrigger);
    expect(new CSharpHangfireTriggerResolver().resolve(one).map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`)).toEqual([
      "FleetController.ServiceNow -> FleetService.ServiceFleet",
    ]);
  });
});
