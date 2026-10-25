import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";

/**
 * What every session pays before its first question: the tool list and the
 * server instructions. 17,645 + 2,768 bytes when this budget was set out,
 * 22,341 + 3,328 with eighteen tools, 22,477 + 2,498 once the instructions
 * stopped repeating the tool descriptions. A description that grows the total
 * past the budget has to be argued for in the commit that raises it.
 */
const BUDGET_BYTES = 25_500;

afterEach(() => {
  delete process.env.CLARIFYDOC_MCP_LOG;
});

describe("what a session pays up front", () => {
  it("keeps tools/list and the instructions under the budget", async () => {
    const { server } = buildMcpServer({ projectRoot: tmpdir(), allowAnalyze: false, allowColdStart: false });
    const list = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as { result: unknown };
    const init = (await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })) as { result: { instructions?: string } };
    // `_meta` is for the host (Claude Code reads `anthropic/alwaysLoad` to decide what to load), not for the
    // model's context, so it is not counted.
    const listed = JSON.stringify(list.result, (k, v) => (k === "_meta" ? undefined : v));
    const bytes = Buffer.byteLength(listed) + Buffer.byteLength(init.result.instructions ?? "");
    expect(bytes, `tools/list + instructions = ${bytes} bytes`).toBeLessThan(BUDGET_BYTES);
  });

  it("asks a deferring host to load search and trace up front, and nothing else", async () => {
    const { server } = buildMcpServer({ projectRoot: tmpdir(), allowAnalyze: false, allowColdStart: false });
    const list = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } };
    expect(list.result.tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name)).toEqual(["clarifydoc_search", "clarifydoc_trace"]);
  });

  it("logs each call locally when asked, cutting long arguments and marking empty answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarifydoc-mcplog-"));
    try {
      process.env.CLARIFYDOC_MCP_LOG = join(dir, "calls.jsonl");
      const { server } = buildMcpServer({ projectRoot: resolve("test-fixtures/sample-backend"), analysisDir: resolve("test-output/sample-backend"), allowAnalyze: false, allowColdStart: false });
      const call = (args: Record<string, unknown>) => server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "clarifydoc_routes", arguments: args } });
      await call({ path: "/api/players" });
      await call({ path: "x".repeat(300) });
      const lines = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => [l.tool, l.isError, l.empty])).toEqual([["clarifydoc_routes", false, false], ["clarifydoc_routes", false, true]]);
      expect(lines[1].args.path).toMatch(/… \(300 chars\)$/);
      expect(lines[0].chars).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
