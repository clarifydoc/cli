import type { EntryPointInfo } from "../../../types/analysis.js";

/**
 * Ruby scheduled jobs — code a clock runs:
 *  - whenever (`config/schedule.rb`): `every 1.day, at: "4:30 am" do … runner "Report.nightly" … end`
 *  - clockwork: `every(1.hour, "sync") { SyncJob.perform_later }`
 *  - sidekiq-cron: `Sidekiq::Cron::Job.create(name: "x", cron: "*\/5 * * * *", class: "HardWorker")`
 * The handler is the method or job class named (`Report.nightly`, `HardWorker.perform`).
 */
export function extractRubyScheduledJobs(lines: string[]): EntryPointInfo[] {
  const text = lines.join("\n");
  if (!/^\s*every\b|Sidekiq::Cron::Job/m.test(text)) return [];
  const out: EntryPointInfo[] = [];
  let every: { schedule: string; line: number } | null = null;
  lines.forEach((line, i) => {
    const cron = /Sidekiq::Cron::Job\.(?:create|new)\s*\(?(.*)/.exec(line);
    if (cron) {
      const args = cron[1]!;
      const cls = /class:\s*["']([\w:]+)["']/.exec(args)?.[1];
      const name = /name:\s*["']([^"']+)["']/.exec(args)?.[1];
      const schedule = /cron:\s*["']([^"']+)["']/.exec(args)?.[1];
      out.push({ kind: "scheduled-job", name: name ?? cls ?? "sidekiq-cron job", line: i + 1, framework: "sidekiq-cron", ...(cls ? { handler: `${cls}.perform` } : {}), ...(schedule ? { schedule } : {}) });
      return;
    }
    // clockwork: `every(1.hour, "sync") { SyncJob.perform_later }` on one line.
    const clock = /^\s*every\s*\(\s*([^,]+),\s*["']([^"']+)["'][^{]*\{\s*([\w:]+)\.(\w+)/.exec(line);
    if (clock) {
      const handler = /^perform/.test(clock[4]!) ? `${clock[3]}.perform` : `${clock[3]}.${clock[4]}`;
      out.push({ kind: "scheduled-job", name: clock[2]!, handler, line: i + 1, framework: "clockwork", schedule: `every ${clock[1]!.trim()}` });
      return;
    }
    // whenever: the `every` block's runner/rake lines are its jobs.
    const block = /^\s*every\s+(.+?)\s+do\s*(?:\|[^|]*\|)?\s*$/.exec(line);
    if (block) {
      every = { schedule: `every ${block[1]!.replace(/["']/g, "")}`, line: i + 1 };
      return;
    }
    if (every && /^\s*end\b/.test(line)) {
      every = null;
      return;
    }
    if (every) {
      const runner = /^\s*runner\s+["']([\w:]+)\.(\w+)[^"']*["']/.exec(line);
      const rake = /^\s*rake\s+["']([^"']+)["']/.exec(line);
      if (runner) out.push({ kind: "scheduled-job", name: `${runner[1]}.${runner[2]}`, handler: `${runner[1]}.${runner[2]}`, line: i + 1, framework: "whenever", schedule: every.schedule });
      else if (rake) out.push({ kind: "scheduled-job", name: `rake ${rake[1]}`, line: i + 1, framework: "whenever", schedule: every.schedule });
    }
  });
  return out;
}
