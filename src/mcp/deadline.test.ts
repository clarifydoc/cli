/**
 * A long analysis outlives a client's call deadline: the call answers that it
 * is still running and says where it is, the run goes on, and the next call
 * waits for that same run instead of starting another.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { cp, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-deadline-"));
  await cp(resolve("test-fixtures/sample-backend"), join(dir, "proj"), { recursive: true });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.CLARIFYDOC_MCP_WAIT_MS;
});

describe("call deadlines", () => {
  it("answers pending with the run's progress, then joins the same run", async () => {
    const logs: string[] = [];
    const { server } = buildMcpServer({ projectRoot: join(dir, "proj"), analysisDir: join(dir, "out", "proj"), allowAnalyze: true, analyzeSettings: { gitHistory: false }, log: (m) => logs.push(m) });
    const notes: Array<Record<string, unknown>> = [];
    server.setNotifier((m) => notes.push(m));
    const call = async (id: number) => {
      const res = (await server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "clarifydoc_analyze", arguments: {}, _meta: { progressToken: "t1" } } })) as { result: { content: Array<{ text: string }> } };
      return res.result.content[0]!.text;
    };

    process.env.CLARIFYDOC_MCP_WAIT_MS = "30";
    const first = await call(1);
    expect(first).toMatch(/^The analysis is still running \(.+, \d+s so far\)\. It goes on in the background/);

    process.env.CLARIFYDOC_MCP_WAIT_MS = "120000";
    const second = await call(2);
    expect(second).toMatch(/^Analysis complete in/);
    // One run: the second call joined it.
    expect(logs.filter((l) => l.startsWith("analysis complete")).length).toBe(1);
    expect(logs.some((l) => l.includes("analysis already running"))).toBe(true);
    // Progress went out against the caller's token, ever increasing.
    const steps = notes.filter((n) => n.method === "notifications/progress").map((n) => (n.params as { progress: number; progressToken: string }));
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.progress).toBeGreaterThan(steps[i - 1]!.progress);
    expect(steps.every((s) => s.progressToken === "t1")).toBe(true);
  }, 120_000);

  it("cancel stops the running analysis; its waiters hear so and the next call starts afresh", async () => {
    const logs: string[] = [];
    const { server } = buildMcpServer({ projectRoot: join(dir, "proj"), analysisDir: join(dir, "out", "cancel"), allowAnalyze: true, analyzeSettings: { gitHistory: false }, log: (m) => logs.push(m) });
    const call = async (id: number, args: Record<string, unknown> = {}) => {
      const res = (await server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "clarifydoc_analyze", arguments: args } })) as { result: { content: Array<{ text: string }> } };
      return res.result.content[0]!.text;
    };

    expect(await call(1, { cancel: true })).toBe("No analysis is running.");
    process.env.CLARIFYDOC_MCP_WAIT_MS = "30";
    expect(await call(2)).toContain("cancel=true stops it.");
    expect(await call(3, { cancel: true })).toMatch(/^Cancelled/);

    process.env.CLARIFYDOC_MCP_WAIT_MS = "120000";
    // The cancelled run is over; this one is new and completes.
    expect(await call(4)).toMatch(/^Analysis complete in/);
    expect(logs).toContain("analysis cancelled");
    expect(logs.filter((l) => l.startsWith("analysis complete")).length).toBe(1);
  }, 120_000);
});
