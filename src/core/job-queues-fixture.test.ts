import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-job-queues, against the channels its README labels by hand. */
const fixture = resolve("test-fixtures/sample-job-queues");

describe.skipIf(!existsSync(fixture))("sample-job-queues", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-job-queues-"));
    out = join(dir, "sample-job-queues");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("meets each publisher and consumer at one channel node", async () => {
    const s = await loadReportSummary(out);
    const edges = s.dataAccessGraph!.edges
      .filter((e) => e.source.startsWith("queue::") || e.target.startsWith("queue::"))
      .map((e) => `${e.source} -> ${e.target}`);
    expect(edges.sort()).toEqual([
      "file::node-api/src/chat-client.ts -> queue::chat message",
      "file::node-api/src/chat-server.ts -> queue::chat message",
      "file::node-api/src/server.ts -> queue::emails",
      "file::py-app/app/views.py -> queue::generate_report",
      "queue::archive_reports -> file::py-app/app/tasks.py",
      "queue::chat message -> file::node-api/src/chat-client.ts",
      "queue::chat message -> file::node-api/src/chat-server.ts",
      "queue::emails -> file::node-api/src/worker.ts",
      "queue::generate_report -> file::py-app/app/tasks.py",
    ]);
  });

  it("follows each route through its queue to the table the consumer writes", async () => {
    const s = await loadReportSummary(out);
    const flows = (s.dataFlows ?? []).filter((p) => p.effect === "db-write").map((p) => `${p.entryLabel} ${p.resource}`);
    expect(flows.filter((f) => f.startsWith("POST")).sort()).toEqual(["POST /reports/<int:report_id> reports", "POST /signup sent_emails"]);
    const mq = s.symbolLinks.filter((l) => l.strategy === "queue").map((l) => `${l.sourceFile}:${l.sourceSymbol} -> ${l.targetFile}:${l.targetSymbol}`);
    expect(mq).toContain("node-api/src/server.ts:route:POST /signup -> node-api/src/worker.ts:<setup>");
    expect(mq).toContain("py-app/app/views.py:request_report -> py-app/app/tasks.py:generate_report");
    expect(mq).toContain("node-api/src/chat-client.ts:send -> node-api/src/chat-server.ts:<setup>");
  });

  it("starts a flow at each scheduled job and message consumer, as the README labels them", async () => {
    const s = await loadReportSummary(out);
    const entries = (s.entryPoints ?? [])
      .filter((e) => e.kind === "scheduled-job" || e.kind === "message-consumer")
      .map((e) => `${e.kind} ${e.name} → ${e.handler} (${e.filePath})${e.schedule ? ` [${e.schedule}]` : ""}`);
    expect(entries.sort()).toEqual([
      "message-consumer archive_reports → archive_reports (py-app/app/tasks.py)",
      "message-consumer chat message → <setup> (node-api/src/chat-server.ts)",
      "message-consumer chat message → listen (node-api/src/chat-client.ts)",
      "message-consumer emails → <setup> (node-api/src/worker.ts)",
      "message-consumer generate_report → generate_report (py-app/app/tasks.py)",
      "scheduled-job archive-reports → archive_reports (py-app/app/celery_app.py) [crontab(hour=2, minute=0)]",
      "scheduled-job purgeSessions → purgeSessions (node-api/src/cron.ts) [0 3 * * *]",
    ]);
    const flows = (s.dataFlows ?? []).filter((p) => p.entryKind === "command" && p.effect === "db-write").map((p) => `${p.entryLabel} ${p.resource}`);
    expect(flows.sort()).toEqual([
      "consumer of archive_reports report_archive",
      "consumer of emails sent_emails",
      "consumer of generate_report reports",
      "scheduled job archive-reports report_archive",
      "scheduled job purgeSessions sessions",
    ]);
  });
});
