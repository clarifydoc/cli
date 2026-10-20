import type { EntryPointInfo } from "../../../types/analysis.js";

/**
 * .NET scheduled jobs — methods a clock runs:
 *  - Hangfire `RecurringJob.AddOrUpdate("id", () => svc.Run(), Cron.Daily)` and the generic
 *    `AddOrUpdate<IReport>("id", x => x.Build(), "0 3 * * *")` (also on an `IRecurringJobManager`)
 *  - Quartz.NET: a class implementing `IJob` (`Execute`)
 * Read off the source text; the handler is `Type.Method` when the type is stated, else the method.
 */
export function extractCsharpScheduledJobs(sourceText: string): EntryPointInfo[] {
  if (!/\bAddOrUpdate\b|\bIJob\b/.test(sourceText)) return [];
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
  return out;
}
