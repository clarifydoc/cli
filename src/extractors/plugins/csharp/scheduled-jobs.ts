import type { EntryPointInfo } from "../../../types/analysis.js";
import { lineIndex } from "../shared/text-scan.js";

/**
 * .NET scheduled jobs — methods a clock runs:
 *  - Hangfire `RecurringJob.AddOrUpdate("id", () => svc.Run(), Cron.Daily)` and the generic
 *    `AddOrUpdate<IReport>("id", x => x.Build(), "0 3 * * *")` (also on an `IRecurringJobManager`);
 *    the id may be a string literal, `nameof(…)`, a bare identifier, or a `Class.Const` the file
 *    declares as `const string` (resolved to that literal when exactly one such declaration exists)
 *  - Quartz.NET: a class implementing `IJob` (`Execute`)
 *  - a hosted worker deriving `BackgroundService` (`ExecuteAsync`), with the interval its loop
 *    waits when it states one (`new PeriodicTimer(TimeSpan.FromMinutes(5))`, `Task.Delay(TimeSpan.FromHours(1))`)
 * Read off the source text; the handler is `Type.Method` when the type is stated, else the method.
 * A same-file `const string Leaf = "…"` resolves to its literal when the file declares it once. These are the id
 * shapes the Hangfire trigger resolver accepts too.
 */
export function extractCsharpScheduledJobs(sourceText: string): EntryPointInfo[] {
  if (!/\bAddOrUpdate\b|\bIJob\b|\bBackgroundService\b/.test(sourceText)) return [];
  const out: EntryPointInfo[] = [];
  const lineAt = lineIndex(sourceText);
  /** A `const string Leaf = "value"` the file declares exactly once → that value; else the leaf name. */
  const constId = (expr: string): string => {
    const leaf = expr.split(".").pop()!;
    const hits = [...sourceText.matchAll(new RegExp(`\\bconst\\s+string\\s+${leaf}\\s*=\\s*"([^"]*)"`, "g"))];
    return hits.length === 1 ? hits[0]![1]! : leaf;
  };
  const recurring =
    /\.AddOrUpdate\s*(?:<\s*([\w.]+)\s*>)?\s*\(\s*(?:"([^"]+)"|nameof\(([\w.]+)\)|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))\s*,\s*(?:\(\s*\)|\w+|\(\s*\w+\s*\))\s*=>\s*(?:[\w.]+\.)?(\w+)\s*\(/g;
  for (const m of sourceText.matchAll(recurring)) {
    const [, type, id, nameofId, identId, methodName] = m;
    // The schedule is the next argument after the lambda's call: `Cron.Daily`, `Cron.Hourly()`, "0 3 * * *".
    const rest = sourceText.slice(m.index! + m[0].length);
    const close = rest.indexOf(")");
    const schedule = close >= 0 ? /^\s*,\s*("([^"]+)"|[\w.]+(?:\(\s*[^)]*\))?)/.exec(rest.slice(close + 1)) : null;
    const handler = type ? `${type.split(".").pop()}.${methodName}` : methodName!;
    out.push({
      kind: "scheduled-job",
      name: id ?? nameofId ?? (identId ? constId(identId) : handler),
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
