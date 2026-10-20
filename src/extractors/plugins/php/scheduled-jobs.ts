import type { EntryPointInfo } from "../../../types/analysis.js";

/**
 * PHP scheduled jobs — code a clock runs:
 *  - Laravel's scheduler: `$schedule->job(new SendReports)->daily()`, `->command("emails:send")->hourly()`,
 *    `Schedule::job(new X)->everyFiveMinutes()` (Laravel 11 `routes/console.php`)
 *  - Symfony Scheduler: `#[AsCronTask('0 * * * *')]` / `#[AsPeriodicTask('1 hour')]` on a class (its `__invoke`)
 * Read off the source text; the handler is the job class's `handle` (Laravel) or `__invoke` (Symfony).
 */
export function extractPhpScheduledJobs(sourceText: string): EntryPointInfo[] {
  if (!/(?:\$schedule->|Schedule::)\s*(?:job|command|call)\b|#\[As(?:Cron|Periodic)Task/.test(sourceText)) return [];
  const out: EntryPointInfo[] = [];
  const lineAt = (i: number) => sourceText.slice(0, i).split("\n").length;
  const laravel = /(?:\$schedule->|Schedule::)\s*(job|command|call)\s*\(\s*(?:new\s+\\?([\w\\]+)|['"]([^'"]+)['"]|([\w\\]+)::class)?[^;]*?\)((?:\s*->\s*\w+\s*\([^)]*\))*)\s*;/g;
  for (const m of sourceText.matchAll(laravel)) {
    const [, what, newClass, command, classRef, chain] = m;
    const cls = (newClass ?? classRef)?.split("\\").pop();
    const schedule = (chain ?? "").match(/->\s*(\w+)\s*\(([^)]*)\)/g)?.map((c) => c.replace(/->\s*/, "").replace(/\(\s*\)$/, "")).join(" ") || undefined;
    const name = cls ?? (command ? command : what === "call" ? "closure" : "job");
    out.push({
      kind: "scheduled-job",
      name,
      line: lineAt(m.index!),
      framework: "laravel",
      ...(cls ? { handler: `${cls}.handle` } : {}),
      ...(schedule ? { schedule } : {}),
    });
  }
  for (const m of sourceText.matchAll(/#\[As(Cron|Periodic)Task\s*\(\s*['"]([^'"]+)['"][^\]]*\]\s*(?:final\s+|readonly\s+)*class\s+(\w+)/g)) {
    out.push({ kind: "scheduled-job", name: m[3]!, handler: `${m[3]}.__invoke`, line: lineAt(m.index!), framework: "symfony", schedule: m[2]! });
  }
  return out;
}
