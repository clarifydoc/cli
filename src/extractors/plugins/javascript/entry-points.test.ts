import { describe, expect, it } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractEntryPoints } from "./entry-points.js";
import { extractPythonEntryPoints } from "../python/entry-points.js";

const js = async (src: string) => extractEntryPoints(await parseSource(src, "typescript" as never, "src/x.ts"), src).map((e) => `${e.kind} ${e.name}${e.handler ? ` → ${e.handler}` : ""} (${e.framework})`);
const py = async (src: string) => extractPythonEntryPoints(await parseSource(src, "python" as never, "app.py"), src).map((e) => `${e.kind} ${e.name} → ${e.handler} (${e.framework})`);

describe("entry points that are not routes", () => {
  it("Python: APScheduler, schedule, Celery beat and periodic tasks", async () => {
    const { extractPythonScheduledJobs } = await import("../python/entry-points.js");
    const src = `
from apscheduler.schedulers.background import BackgroundScheduler
scheduler = BackgroundScheduler()
scheduler.add_job(purge_sessions, "cron", hour=3, id="purge")

@scheduler.scheduled_job("interval", minutes=5)
def sync_inventory():
    pass

schedule.every(10).minutes.do(send_digest)

app.conf.beat_schedule = {
    "nightly-report": {"task": "reports.tasks.build_report", "schedule": crontab(hour=1, minute=0)},
}

@periodic_task(run_every=timedelta(hours=1))
def refresh_rates():
    pass
`;
    const got = extractPythonScheduledJobs(await parseSource(src, "python" as never, "jobs.py"), src).map((e) => `${e.kind} ${e.name} → ${e.handler} [${e.schedule}] (${e.framework})`);
    expect(got).toEqual([
      "scheduled-job purge → purge_sessions [cron hour=3] (apscheduler)",
      "scheduled-job sync_inventory → sync_inventory [interval minutes=5] (apscheduler)",
      "scheduled-job send_digest → send_digest [every(10).minutes] (schedule)",
      "scheduled-job nightly-report → build_report [crontab(hour=1, minute=0)] (celery-beat)",
      "scheduled-job refresh_rates → refresh_rates [timedelta(hours=1)] (celery)",
    ]);
  });

  it("JS/TS: scheduled jobs — node-cron, node-schedule, cron, NestJS, agenda — and not a queue's schedule()", async () => {
    const src = `
cron.schedule("*/5 * * * *", syncInventory);
schedule.scheduleJob("nightly", "0 3 * * *", rebuildIndex);
const job = new CronJob("0 * * * *", purgeSessions);
CronJob.from({ cronTime: "@daily", onTick: sendDigest, start: true });
agenda.define("send email", sendEmail);
agenda.every("5 minutes", "send email");
queue.schedule(job, later); // not cron
export class Reports {
  @Cron("0 0 1 * *", { name: "monthly-report" })
  async monthly() {}
  @Interval(10000)
  tick() {}
}`;
    const got = extractEntryPoints(await parseSource(src, "typescript" as never, "src/jobs.ts"), src).map((e) => `${e.kind} ${e.name} → ${e.handler} [${e.schedule}] (${e.framework})`);
    expect(got).toEqual([
      "scheduled-job syncInventory → syncInventory [*/5 * * * *] (node-cron)",
      "scheduled-job nightly → rebuildIndex [0 3 * * *] (node-schedule)",
      "scheduled-job purgeSessions → purgeSessions [0 * * * *] (cron)",
      "scheduled-job sendDigest → sendDigest [@daily] (cron)",
      "scheduled-job send email → sendEmail [every 5 minutes] (agenda)",
      "scheduled-job monthly-report → Reports.monthly [0 0 1 * *] (nestjs)",
      "scheduled-job Reports.tick → Reports.tick [every 10000 ms] (nestjs)",
    ]);
  });

  it("JS/TS: MCP tools, VS Code commands and LM tools, commander and yargs commands", async () => {
    expect(await js(`
server.tool("search_orders", { q: z.string() }, searchOrders);
server.registerTool("close_order", { description: "x" }, async (args) => close(args));
vscode.commands.registerCommand("shop.refresh", () => refresh());
context.subscriptions.push(commands.registerTextEditorCommand("shop.format", this.format));
vscode.lm.registerTool("shop_lookup", new LookupTool());
program.command("deploy <env>").description("ship it").action(deploy);
yargs.command("serve [port]", "start", (y) => y, serve);
router.command; // not a call
emitter.tool(name, fn); // not a literal name
`)).toEqual([
      "mcp-tool search_orders → searchOrders (mcp)",
      "mcp-tool close_order (mcp)",
      "editor-command shop.refresh (vscode)",
      "editor-command shop.format → format (vscode)",
      "lm-tool shop_lookup (vscode)",
      "cli-command deploy → deploy (commander)",
      "cli-command serve → serve (yargs)",
    ]);
  });

  it("Python: FastMCP tools and click / typer commands from their decorators", async () => {
    expect(await py(`
@mcp.tool()
def search_orders(q: str) -> list: ...

@server.tool(name="close")
async def close_order(id: int): ...

@cli.command()
def import_data(): ...

@app.command("seed-db")
def seed(): ...
`)).toEqual([
      "mcp-tool search_orders → search_orders (mcp)",
      "mcp-tool close → close_order (mcp)",
      "cli-command import-data → import_data (click)",
      "cli-command seed-db → seed (typer)",
    ]);
  });
});
