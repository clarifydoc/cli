import type { EntryPointInfo } from "../../../types/analysis.js";

/**
 * JVM scheduled jobs — methods a clock runs:
 *  - Spring `@Scheduled(cron = "0 0 * * * *")` / `fixedRate` / `fixedDelay`, and Quarkus `@Scheduled(every = "10s")`
 *  - Quartz: a class implementing `Job` (`execute`) or extending `QuartzJobBean` (`executeInternal`)
 * Read off the source text; the handler is `Class.method`, as call links name it.
 */
export function extractJvmScheduledJobs(sourceText: string, language: "java" | "kotlin"): EntryPointInfo[] {
  if (!/@Scheduled\b|\bQuartzJobBean\b|\bJob\b/.test(sourceText)) return [];
  const out: EntryPointInfo[] = [];
  const lineAt = (i: number) => sourceText.slice(0, i).split("\n").length;
  // The class around an index: the last class header before it (nested classes are rare in job code).
  const classes = [...sourceText.matchAll(/\bclass\s+(\w+)/g)].map((m) => ({ at: m.index!, name: m[1]! }));
  const classAt = (i: number) => classes.filter((c) => c.at < i).pop()?.name;
  const method = language === "kotlin"
    ? /^(?:\s*@\w+(?:\.\w+)*(?:\([^)]*\))?)*\s*(?:(?:public|private|protected|internal|open|override|suspend|final)\s+)*fun\s+(\w+)/
    : /^(?:\s*@\w+(?:\.\w+)*(?:\([^)]*\))?)*\s*(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:<[^>]*>\s*)?[\w<>[\],.?\s]+?\s+(\w+)\s*\(/;
  for (const m of sourceText.matchAll(/@Scheduled\s*(?:\(([^)]*)\))?/g)) {
    const after = sourceText.slice(m.index! + m[0].length);
    const name = method.exec(after)?.[1];
    if (!name) continue;
    const args = (m[1] ?? "").trim();
    const schedule = /\bcron\s*=\s*"([^"]+)"/.exec(args)?.[1] ?? /\bevery\s*=\s*"([^"]+)"/.exec(args)?.[1] ?? (args.replace(/\s+/g, " ") || undefined);
    const cls = classAt(m.index!);
    const handler = cls ? `${cls}.${name}` : name;
    out.push({ kind: "scheduled-job", name: handler, handler, line: lineAt(m.index!), framework: /\bevery\s*=/.test(args) ? "quarkus" : "spring", ...(schedule ? { schedule } : {}) });
  }
  // Quartz: the job class's execute method is what the scheduler calls.
  const quartz = language === "kotlin"
    ? /\bclass\s+(\w+)[^{]*?:\s*[^{]*?\b(Job|QuartzJobBean)\b/g
    : /\bclass\s+(\w+)[^{]*?\b(?:implements\s+[^{]*?\bJob\b|extends\s+QuartzJobBean\b)/g;
  for (const m of sourceText.matchAll(quartz)) {
    const bean = /QuartzJobBean/.test(m[0]);
    const handler = `${m[1]}.${bean ? "executeInternal" : "execute"}`;
    out.push({ kind: "scheduled-job", name: m[1]!, handler, line: lineAt(m.index!), framework: "quartz" });
  }
  return out;
}
