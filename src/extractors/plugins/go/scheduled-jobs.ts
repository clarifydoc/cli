import type { EntryPointInfo } from "../../../types/analysis.js";

/**
 * Go scheduled jobs — functions a clock runs:
 *  - robfig/cron `c.AddFunc("0 30 * * * *", sync)` / `c.AddJob("@every 1m", job)`
 *  - go-co-op/gocron v1 `s.Every(1).Day().At("10:30").Do(task)`, v2
 *    `s.NewJob(gocron.DurationJob(10*time.Second), gocron.NewTask(task))`
 * The handler is the function named (an inline `func() {…}` has none).
 */
export function extractGoScheduledJobs(lines: string[]): EntryPointInfo[] {
  const text = lines.join("\n");
  if (!/\.(?:AddFunc|AddJob|Every|NewJob)\s*\(/.test(text)) return [];
  const out: EntryPointInfo[] = [];
  const named = (expr: string): string | undefined => {
    const id = /^\s*&?([A-Za-z_][\w.]*)\s*(?:[,)]|$)/.exec(expr)?.[1];
    return id && id !== "func" ? id.split(".").pop() : undefined;
  };
  lines.forEach((line, i) => {
    const robfig = /\.(AddFunc|AddJob)\s*\(\s*"([^"]+)"\s*,\s*(.*)$/.exec(line);
    if (robfig) {
      const handler = named(robfig[3]!);
      out.push({ kind: "scheduled-job", name: handler ?? robfig[2]!, line: i + 1, framework: "robfig/cron", schedule: robfig[2]!, ...(handler ? { handler } : {}) });
      return;
    }
    const v1 = /\.Every\s*\(([^)]*)\)((?:\.\w+\([^)]*\))*?)\.Do\s*\(\s*(.*)$/.exec(line);
    if (v1) {
      const handler = named(v1[3]!);
      const schedule = `every ${v1[1]!.trim() || "1"}${v1[2]!.replace(/\.(\w+)\(([^)]*)\)/g, (_m, f: string, a: string) => ` ${f.toLowerCase()}${a ? ` ${a.replace(/"/g, "")}` : ""}`)}`;
      out.push({ kind: "scheduled-job", name: handler ?? schedule, line: i + 1, framework: "gocron", schedule, ...(handler ? { handler } : {}) });
      return;
    }
    const v2 = /\.NewJob\s*\(\s*gocron\.(\w+Job)\(([^)]*)\)\s*,\s*gocron\.NewTask\s*\(\s*(.*)$/.exec(line);
    if (v2) {
      const handler = named(v2[3]!);
      const schedule = `${v2[1]!.replace(/Job$/, "").toLowerCase()} ${v2[2]!.replace(/"/g, "").trim()}`.trim();
      out.push({ kind: "scheduled-job", name: handler ?? schedule, line: i + 1, framework: "gocron", schedule, ...(handler ? { handler } : {}) });
    }
  });
  return out;
}
