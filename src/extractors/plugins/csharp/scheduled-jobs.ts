import type { EntryPointInfo } from "../../../types/analysis.js";

/**
 * .NET scheduled jobs — methods a clock runs:
 *  - Hangfire `RecurringJob.AddOrUpdate("id", () => svc.Run(), Cron.Daily)` and the generic
 *    `AddOrUpdate<IReport>("id", x => x.Build(), "0 3 * * *")` (also on an `IRecurringJobManager`)
 *  - Quartz.NET: a class implementing `IJob` (`Execute`)
 *  - a hosted worker deriving `BackgroundService` (`ExecuteAsync`), with the interval its loop
 *    waits when it states one (`new PeriodicTimer(TimeSpan.FromMinutes(5))`, `Task.Delay(TimeSpan.FromHours(1))`)
 * Read off the source text; the handler is `Type.Method` when the type is stated, else the method.
 */
export function extractCsharpScheduledJobs(sourceText: string): EntryPointInfo[] {
  if (!/\bAddOrUpdate\b|\bIJob\b|\bBackgroundService\b/.test(sourceText)) return [];
  const out: EntryPointInfo[] = [];
  const lineAt = (i: number) => sourceText.slice(0, i).split("\n").length;
  const recurring = /\.AddOrUpdate\s*(?:<\s*([\w.]+)\s*>)?\s*\(\s*(?:"([^"]+)"|nameof\(([\w.]+)\))\s*,\s*(?:\(\s*\)|\w+|\(\s*\w+\s*\))\s*=>\s*(?:[\w.]+\.)?(\w+)\s*\(/g;
  for (const m of sourceText.matchAll(recurring)) {
    const [, type, id, nameofId, methodName] = m;
    // The schedule is the next argument after the lambda's call: `Cron.Daily`, `Cron.Hourly()`, "0 3 * * *".
    const rest = sourceText.slice(m.index! + m[0].length);
    const close = rest.indexOf(")");
    const schedule = close >= 0 ? /^\s*,\s*("([^"]+)"|[\w.]+(?:\(\s*[^)]*\))?)/.exec(rest.slice(close + 1)) : null;
    const handler = type ? `${type.split(".").pop()}.${methodName}` : methodName!;
    out.push({
      kind: "scheduled-job",
      name: id ?? nameofId ?? handler,
      handler,
      line: lineAt(m.index!),
      framework: "hangfire",
      ...(schedule ? { schedule: schedule[2] ?? schedule[1]! } : {}),
    });
  }
  for (const m of sourceText.matchAll(/\bclass\s+(\w+)\s*:[^{]*\bIJob\b/g)) {
    out.push({ kind: "scheduled-job", name: m[1]!, handler: `${m[1]}.Execute`, line: lineAt(m.index!), framework: "quartz" });
  }
  for (const m of sourceText.matchAll(/\bclass\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*(?:Microsoft\.Extensions\.Hosting\.)?BackgroundService\b/g)) {
    if (!/\boverride\s+(?:async\s+)?Task\s+ExecuteAsync\s*\(/.test(sourceText)) continue;
    const interval = /\b(?:new\s+PeriodicTimer|Task\.Delay)\s*\(\s*(TimeSpan\.From\w+\s*\([^()]*\))/.exec(sourceText)?.[1];
    out.push({
      kind: "scheduled-job",
      name: m[1]!,
      handler: `${m[1]}.ExecuteAsync`,
      line: lineAt(m.index!),
      framework: "hosted-service",
      ...(interval ? { schedule: interval.replace(/\s+/g, "") } : {}),
    });
  }
  return out;
}
