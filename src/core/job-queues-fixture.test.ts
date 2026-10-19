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
      "queue::chat message -> file::node-api/src/chat-client.ts",
      "queue::chat message -> file::node-api/src/chat-server.ts",
      "queue::emails -> file::node-api/src/worker.ts",
      "queue::generate_report -> file::py-app/app/tasks.py",
    ]);
  });

  it("follows each route through its queue to the table the consumer writes", async () => {
    const s = await loadReportSummary(out);
    const flows = (s.dataFlows ?? []).filter((p) => p.effect === "db-write").map((p) => `${p.entryLabel} ${p.resource}`);
    expect(flows.sort()).toEqual(["POST /reports/<int:report_id> reports", "POST /signup sent_emails"]);
    const mq = s.symbolLinks.filter((l) => l.strategy === "queue").map((l) => `${l.sourceFile}:${l.sourceSymbol} -> ${l.targetFile}:${l.targetSymbol}`);
    expect(mq).toContain("node-api/src/server.ts:route:POST /signup -> node-api/src/worker.ts:<setup>");
    expect(mq).toContain("py-app/app/views.py:request_report -> py-app/app/tasks.py:generate_report");
    expect(mq).toContain("node-api/src/chat-client.ts:send -> node-api/src/chat-server.ts:<setup>");
  });
});
