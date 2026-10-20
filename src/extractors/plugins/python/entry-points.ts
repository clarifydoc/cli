import type { Node, Tree } from "web-tree-sitter";
import type { EntryPointInfo } from "../../../types/analysis.js";

/**
 * Python entry points that are not routes, read off decorators:
 *  - MCP tools: FastMCP `@mcp.tool()` / `@server.tool(name="x")`
 *  - CLIs: click `@cli.command()` / `@click.command("x")`, typer `@app.command()`
 * The decorated function is the handler; a name argument, when given, is how
 * the tool or command is invoked (click and typer also turn `snake_case` into
 * `snake-case`).
 */
export function extractPythonEntryPoints(tree: Tree, sourceText: string): EntryPointInfo[] {
  if (!/@\w[\w.]*\.(?:tool|command)\b/.test(sourceText)) return [];
  const out: EntryPointInfo[] = [];
  const visit = (n: Node): void => {
    if (n.type === "decorated_definition") {
      const def = n.childForFieldName("definition");
      const fn = def?.type === "function_definition" ? def.childForFieldName("name")?.text : undefined;
      if (fn) {
        for (const d of n.namedChildren.filter((c) => c.type === "decorator")) {
          const text = d.text.replace(/^@/, "");
          const m = /^([\w.]+)\.(tool|command)\s*(\((.*)\))?\s*$/s.exec(text);
          if (!m) continue;
          const [, obj, what, , argText = ""] = m;
          const named = /(?:^|,)\s*(?:name\s*=\s*)?["']([^"']+)["']/.exec(argText)?.[1];
          if (what === "tool" && /mcp|server/i.test(obj!)) {
            out.push({ kind: "mcp-tool", name: named ?? fn, handler: fn, line: n.startPosition.row + 1, framework: "mcp" });
          } else if (what === "command") {
            const framework = /^click$/.test(obj!) || /group|cli/i.test(obj!) ? "click" : "typer";
            out.push({ kind: "cli-command", name: named ?? fn.replace(/_/g, "-"), handler: fn, line: n.startPosition.row + 1, framework });
          }
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(tree.rootNode);
  return out;
}

/**
 * Python scheduled jobs — functions a clock runs:
 *  - APScheduler `scheduler.add_job(fn, "cron", hour=3)` and `@scheduler.scheduled_job("interval", minutes=5)`,
 *    Flask-APScheduler `@scheduler.task("cron", id="x", …)`
 *  - schedule `schedule.every(10).minutes.do(job)`
 *  - Celery beat: `beat_schedule = {"name": {"task": "app.tasks.x", "schedule": …}}`, `@periodic_task(run_every=…)`
 * The handler is the function named (a dotted Celery task name gives its last part).
 */
export function extractPythonScheduledJobs(tree: Tree, sourceText: string): EntryPointInfo[] {
  if (!/\b(?:add_job|scheduled_job|every|periodic_task|task)\s*\(|beat_schedule/i.test(sourceText)) return [];
  const out: EntryPointInfo[] = [];
  const job = (name: string, n: Node, framework: string, schedule: string | undefined, handler: string | undefined) =>
    out.push({ kind: "scheduled-job", name, line: n.startPosition.row + 1, framework, ...(handler ? { handler } : {}), ...(schedule ? { schedule } : {}) });
  const unquote = (t: string) => t.replace(/^[rbuf]*["']{1,3}|["']{1,3}$/g, "");
  /** The trigger and its keyword arguments as written: `cron hour=3`, `interval minutes=5`. */
  const trigger = (argNodes: Node[]): string | undefined => {
    const parts = argNodes
      .filter((a) => a.type === "string" || (a.type === "keyword_argument" && !/^(?:id|name|func|args|kwargs|replace_existing|misfire_grace_time)\s*=/.test(a.text)))
      .map((a) => (a.type === "string" ? unquote(a.text) : a.text.replace(/\s+/g, "")));
    return parts.length ? parts.join(" ") : undefined;
  };
  const kw = (argNodes: Node[], key: string) => {
    const k = argNodes.find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === key);
    const v = k?.childForFieldName("value");
    return v ? (v.type === "string" ? unquote(v.text) : v.text) : undefined;
  };
  const visit = (n: Node): void => {
    if (n.type === "decorated_definition") {
      const def = n.childForFieldName("definition");
      const fn = def?.type === "function_definition" ? def.childForFieldName("name")?.text : undefined;
      for (const d of fn ? n.namedChildren.filter((c) => c.type === "decorator") : []) {
        const call = d.namedChildren[0];
        if (call?.type !== "call") continue;
        const callee = call.childForFieldName("function")?.text ?? "";
        const a = call.childForFieldName("arguments")?.namedChildren ?? [];
        if (/\.(?:scheduled_job|task)$/.test(callee) && /sched/i.test(callee)) {
          job(kw(a, "id") ?? fn!, n, "apscheduler", trigger(a), fn);
        } else if (/(?:^|\.)periodic_task$/.test(callee)) {
          job(kw(a, "name") ?? fn!, n, "celery", kw(a, "run_every"), fn);
        }
      }
    } else if (n.type === "call") {
      const fnNode = n.childForFieldName("function");
      const a = n.childForFieldName("arguments")?.namedChildren ?? [];
      if (fnNode?.type === "attribute" && fnNode.childForFieldName("attribute")?.text === "add_job" && a[0] && (a[0].type === "identifier" || a[0].type === "attribute")) {
        const handler = a[0].text.split(".").pop()!;
        job(kw(a, "id") ?? handler, n, "apscheduler", trigger(a.slice(1)), handler);
      } else if (fnNode?.type === "attribute" && fnNode.childForFieldName("attribute")?.text === "do" && /^schedule\.every\b/.test(fnNode.text) && a[0]) {
        // `schedule.every(10).minutes.do(job)` — the chain before `.do` is the schedule.
        const handler = a[0].text.split(".").pop()!;
        job(handler, n, "schedule", fnNode.childForFieldName("object")!.text.replace(/^schedule\./, "").replace(/\s+/g, ""), handler);
      }
    } else if ((n.type === "assignment" || n.type === "pair" || n.type === "keyword_argument") && /beat_schedule/i.test(n.child(0)?.text ?? "")) {
      // Celery beat (`app.conf.beat_schedule = …`, `CELERY_BEAT_SCHEDULE = …`, `conf.update(beat_schedule=…)`):
      // each entry's `task` is the job, `schedule` when it runs.
      const dict = n.type === "assignment" ? n.childForFieldName("right") : n.childForFieldName("value");
      for (const entry of dict?.type === "dictionary" ? dict.namedChildren : []) {
        if (entry.type !== "pair") continue;
        const name = unquote(entry.childForFieldName("key")?.text ?? "");
        const body = entry.childForFieldName("value");
        if (body?.type !== "dictionary") continue;
        let task: string | undefined;
        let schedule: string | undefined;
        for (const p of body.namedChildren) {
          if (p.type !== "pair") continue;
          const key = unquote(p.childForFieldName("key")?.text ?? "");
          const value = p.childForFieldName("value");
          if (key === "task" && value?.type === "string") task = unquote(value.text);
          if (key === "schedule" && value) schedule = value.text.replace(/\s+/g, " ");
        }
        if (task) job(name || task, entry, "celery-beat", schedule, task.split(".").pop());
      }
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(tree.rootNode);
  return out;
}
