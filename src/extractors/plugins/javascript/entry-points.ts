import type { Node, Tree } from "web-tree-sitter";
import type { EntryPointInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/**
 * Entry points that are not HTTP routes: what an agent, an editor or a shell
 * invokes by name.
 *  - MCP tools: `server.tool("name", …, handler)`, `server.registerTool("name", {…}, handler)`
 *  - VS Code: `commands.registerCommand("id", handler)` (and the text-editor
 *    form), language-model tools `lm.registerTool("name", impl)`
 *  - CLIs: commander `.command("deploy <env>")….action(handler)`, yargs
 *    `.command("serve [port]", desc, builder, handler)`
 *  - Scheduled jobs: node-cron `cron.schedule("0 3 * * *", fn)`, node-schedule
 *    `schedule.scheduleJob(rule, fn)`, cron `new CronJob("0 * * * *", fn)` /
 *    `CronJob.from({ cronTime, onTick })`, NestJS `@Cron(…)` / `@Interval(ms)` on a
 *    method, agenda `agenda.define("name", fn)` (its `every` gives the schedule)
 * The handler is named when it is an identifier (or `this.x` / `obj.x`); an
 * inline function has none — its calls belong to the function around it.
 */

function calleeProperty(call: Node): { object: string; property: string } | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const prop = fn.childForFieldName("property")?.text;
  const obj = fn.childForFieldName("object");
  return prop && obj ? { object: obj.text, property: prop } : null;
}

const args = (call: Node): Node[] => call.childForFieldName("arguments")?.namedChildren ?? [];
const isString = (n: Node | undefined): n is Node => !!n && (n.type === "string" || (n.type === "template_string" && !n.text.includes("${")));

/** A handler argument's name: `run`, `this.run` → `run`, `handlers.run` → `run`. */
function handlerName(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "identifier") return n.text;
  if (n.type === "member_expression") return n.childForFieldName("property")?.text;
  return undefined;
}

/** The command name of a commander/yargs spec: `deploy <env> [opts]` → `deploy`. */
const commandName = (spec: string) => spec.trim().split(/\s+/)[0]!.replace(/[<[].*$/, "");

/** commander: the `.action(handler)` chained after `.command("…")`, if any. */
function chainedAction(commandCall: Node): Node | undefined {
  let at: Node | null = commandCall;
  for (let i = 0; i < 12 && at; i++) {
    const member: Node | null = at.parent;
    if (member?.type !== "member_expression") return undefined;
    const call: Node | null = member.parent;
    if (call?.type !== "call_expression") return undefined;
    if (member.childForFieldName("property")?.text === "action") return args(call)[0];
    at = call;
  }
  return undefined;
}

/** A cron expression: five or six fields of digits, `*`, ranges, steps, lists or names. */
const CRON = /^(?:@(?:yearly|annually|monthly|weekly|daily|hourly|reboot)|(?:[\d*?LW#/,\-A-Za-z]+\s+){4,5}[\d*?LW#/,\-A-Za-z]+)$/;
const SCHEDULE_HINT = /\b(?:schedule|scheduleJob|CronJob|Cron|Interval|define)\s*[(.]/;

/** The argument's text as a schedule: a string literal's value, else the expression as written. */
const scheduleText = (n: Node | undefined): string | undefined =>
  !n ? undefined : n.type === "string" || n.type === "template_string" ? stripQuotes(n.text) : n.text.length <= 80 ? n.text : undefined;

/** `{ cronTime: "…", onTick: fn }` → its two properties. */
function cronObject(n: Node | undefined): { schedule?: string; handler?: Node } {
  if (n?.type !== "object") return {};
  const out: { schedule?: string; handler?: Node } = {};
  for (const p of n.namedChildren) {
    if (p.type !== "pair") continue;
    const key = stripQuotes(p.childForFieldName("key")?.text ?? "");
    if (key === "cronTime") out.schedule = scheduleText(p.childForFieldName("value") ?? undefined);
    if (key === "onTick") out.handler = p.childForFieldName("value") ?? undefined;
  }
  return out;
}

export function extractEntryPoints(tree: Tree, sourceText: string): EntryPointInfo[] {
  const registrations = /\b(?:tool|registerTool|registerCommand|registerTextEditorCommand|command)\s*\(/.test(sourceText);
  const schedules = SCHEDULE_HINT.test(sourceText);
  if (!registrations && !schedules) return [];
  const out: EntryPointInfo[] = [];
  const agendaEvery = new Map<string, string>();
  const job = (name: string, line: number, framework: string, schedule: string | undefined, handler: string | undefined) =>
    out.push({ kind: "scheduled-job", name, line, framework, ...(handler ? { handler } : {}), ...(schedule ? { schedule } : {}) });
  const visit = (n: Node): void => {
    if (schedules) scheduledJob(n);
    if (registrations && n.type === "call_expression") {
      const c = calleeProperty(n);
      const a = args(n);
      if (c && isString(a[0])) {
        const name = stripQuotes(a[0].text);
        const line = n.startPosition.row + 1;
        const push = (kind: EntryPointInfo["kind"], handler: Node | undefined, framework: string) =>
          out.push({ kind, name, line, framework, ...(handlerName(handler) ? { handler: handlerName(handler) } : {}) });
        if ((c.property === "tool" || c.property === "registerTool") && /server|mcp/i.test(c.object) && a.length >= 2) {
          push("mcp-tool", a[a.length - 1], "mcp");
        } else if ((c.property === "registerCommand" || c.property === "registerTextEditorCommand") && /commands$/.test(c.object)) {
          push("editor-command", a[1], "vscode");
        } else if (c.property === "registerTool" && /\blm$/.test(c.object)) {
          push("lm-tool", a[1], "vscode");
        } else if (c.property === "command" && name.trim() && !name.startsWith("$")) {
          // yargs: `.command(spec, desc, builder, handler)`; commander: `.command(spec)…action(handler)`.
          const yargsHandler = a.length >= 4 ? a[3] : undefined;
          const action = yargsHandler ?? chainedAction(n);
          if (action || a.length >= 2) out.push({ kind: "cli-command", name: commandName(name), line, framework: yargsHandler ? "yargs" : "commander", ...(handlerName(action) ? { handler: handlerName(action) } : {}) });
        }
      }
    }
    for (const child of n.namedChildren) visit(child);
  };
  const scheduledJob = (n: Node): void => {
    const line = n.startPosition.row + 1;
    if (n.type === "call_expression") {
      const c = calleeProperty(n);
      const a = args(n);
      // node-cron: `cron.schedule("*/5 * * * *", fn)` — the expression must read as cron, so a `queue.schedule(…)` is not one.
      if (c?.property === "schedule" && isString(a[0]) && CRON.test(stripQuotes(a[0].text).trim())) {
        const handler = handlerName(a[1]);
        job(handler ?? stripQuotes(a[0].text), line, "node-cron", stripQuotes(a[0].text), handler);
      } else if (c?.property === "scheduleJob" && /schedule/i.test(c.object) && a.length >= 2) {
        // node-schedule: `scheduleJob([name,] rule, fn)`.
        const named = a.length >= 3 && isString(a[0]) ? stripQuotes(a[0].text) : undefined;
        const rule = scheduleText(named ? a[1] : a[0]);
        const handler = handlerName(a[a.length - 1]);
        job(named ?? handler ?? rule ?? "job", line, "node-schedule", rule, handler);
      } else if (c?.property === "from" && c.object === "CronJob") {
        const { schedule, handler } = cronObject(a[0]);
        job(handlerName(handler) ?? schedule ?? "job", line, "cron", schedule, handlerName(handler));
      } else if (c && (c.property === "define" || c.property === "every") && /agenda/i.test(c.object) && isString(a[0])) {
        if (c.property === "define" && a.length >= 2) {
          job(stripQuotes(a[0].text), line, "agenda", undefined, handlerName(a[a.length - 1]));
        } else if (c.property === "every" && isString(a[1])) {
          agendaEvery.set(stripQuotes(a[1].text), `every ${stripQuotes(a[0].text)}`);
        }
      }
    } else if (n.type === "new_expression" && n.childForFieldName("constructor")?.text === "CronJob") {
      const a = n.childForFieldName("arguments")?.namedChildren ?? [];
      const obj = cronObject(a[0]);
      const schedule = obj.schedule ?? scheduleText(a[0]);
      const handler = handlerName(obj.handler ?? a[1]);
      job(handler ?? schedule ?? "job", line, "cron", schedule, handler);
    } else if (n.type === "decorator") {
      // NestJS: `@Cron("0 * * * *")` / `@Interval(5000)` on the method that follows.
      const call = n.namedChildren[0];
      const name = call?.type === "call_expression" ? call.childForFieldName("function")?.text : undefined;
      if (name !== "Cron" && name !== "Interval") return;
      let method = n.nextNamedSibling;
      while (method?.type === "decorator") method = method.nextNamedSibling;
      if (method?.type !== "method_definition") return;
      const methodName = method.childForFieldName("name")?.text;
      const cls = method.parent?.parent?.type === "class_declaration" || method.parent?.parent?.type === "class"
        ? method.parent.parent.childForFieldName("name")?.text
        : undefined;
      if (!methodName) return;
      const first = args(call!)[0];
      // `@Cron(expr, { name: "nightly" })` names the job.
      const named = /\bname\s*:\s*["'`]([^"'`]+)/.exec(call!.text)?.[1];
      const schedule = name === "Interval" ? (first ? `every ${first.text} ms` : undefined) : scheduleText(first);
      const handler = cls ? `${cls}.${methodName}` : methodName;
      job(named ?? handler, line, "nestjs", schedule, handler);
    }
  };
  visit(tree.rootNode);
  // agenda: `every("5 minutes", "send email")` is the schedule of the job `define` named.
  for (const e of out) if (e.framework === "agenda" && agendaEvery.has(e.name)) e.schedule = agendaEvery.get(e.name);
  return out;
}
