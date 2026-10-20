import { describe, expect, it } from "vitest";
import { extractJvmScheduledJobs } from "./scheduled-jobs.js";
import { extractCsharpScheduledJobs } from "../csharp/scheduled-jobs.js";

const show = (e: { name: string; handler?: string; schedule?: string; framework?: string; line: number }) => `${e.name} → ${e.handler} [${e.schedule ?? ""}] (${e.framework}) @${e.line}`;

describe("scheduled jobs on the JVM and .NET", () => {
  it("Java: Spring @Scheduled methods and Quartz jobs", () => {
    const src = `@Component
public class ReportJobs {
  @Scheduled(cron = "0 0 3 * * *")
  public void nightly() { reports.build(); }

  @Scheduled(fixedRate = 60000)
  @Transactional
  protected void heartbeat() {}

  public void notAJob() {}
}

public class PurgeJob implements Job {
  public void execute(JobExecutionContext ctx) {}
}
class Digest extends QuartzJobBean { protected void executeInternal(JobExecutionContext c) {} }`;
    expect(extractJvmScheduledJobs(src, "java").map(show)).toEqual([
      "ReportJobs.nightly → ReportJobs.nightly [0 0 3 * * *] (spring) @3",
      "ReportJobs.heartbeat → ReportJobs.heartbeat [fixedRate = 60000] (spring) @6",
      "PurgeJob → PurgeJob.execute [] (quartz) @13",
      "Digest → Digest.executeInternal [] (quartz) @16",
    ]);
  });

  it("Kotlin: @Scheduled funs, Quarkus every", () => {
    const src = `class Sync {
    @Scheduled(every = "10s")
    suspend fun pull() {}
}`;
    expect(extractJvmScheduledJobs(src, "kotlin").map(show)).toEqual(["Sync.pull → Sync.pull [10s] (quarkus) @2"]);
  });

  it("C#: Hangfire recurring jobs and Quartz.NET jobs", () => {
    const src = `RecurringJob.AddOrUpdate("purge", () => cleanup.Purge(), Cron.Daily);
manager.AddOrUpdate<IReportService>("monthly", x => x.Build(null), "0 3 1 * *");
public class NightlyJob : IJob { public Task Execute(IJobExecutionContext ctx) => Task.CompletedTask; }`;
    expect(extractCsharpScheduledJobs(src).map(show)).toEqual([
      "purge → Purge [Cron.Daily] (hangfire) @1",
      "monthly → IReportService.Build [0 3 1 * *] (hangfire) @2",
      "NightlyJob → NightlyJob.Execute [] (quartz) @3",
    ]);
  });
});
