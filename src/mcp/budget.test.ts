import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";

/**
 * What every session pays before its first question: the tool list and the
 * server instructions. 17,645 + 2,768 bytes when this budget was set out,
 * 22,341 + 3,328 with eighteen tools, 22,477 + 2,498 once the instructions
 * stopped repeating the tool descriptions, 22,735 + 2,750 with nineteen —
 * then 12,884 + 1,112 once each description became one "use when" sentence
 * and its arguments, the examples moved to the agent guidance. A description
 * that grows a figure past its budget has to be argued for in the commit that
 * raises it. 14,965 + 1,163 with twenty-three: sequence, diff, export and facts
 * (the CLI commands that print what an agent asks for) at ~420 bytes each, the
 * least a tool with arguments costs — the alternative, one tool dispatching on
 * a `command` name, hides from the model which question each one answers.
 */
const BUDGET_BYTES = 16_300;
/** `tools/list` alone, `_meta` aside. */
const TOOLS_LIST_BYTES = 15_000;
/** The server instructions, in characters. */
const INSTRUCTIONS_CHARS = 1_300;

async function upFront(): Promise<{ list: number; instructions: string }> {
  const { server } = buildMcpServer({ projectRoot: tmpdir(), allowAnalyze: false, allowColdStart: false });
  const list = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as { result: unknown };
  const init = (await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })) as { result: { instructions?: string } };
  // `_meta` is for the host (Claude Code reads `anthropic/alwaysLoad` to decide what to load), not for the
  // model's context, so it is not counted.
  const listed = JSON.stringify(list.result, (k, v) => (k === "_meta" ? undefined : v));
  return { list: Buffer.byteLength(listed), instructions: init.result.instructions ?? "" };
}

/** How many arguments each tool takes — what the shorter descriptions must not have dropped. */
const ARGUMENTS: Record<string, number> = {
  clarifydoc_status: 1, clarifydoc_search: 7, clarifydoc_routes: 17, clarifydoc_contract: 5, clarifydoc_services: 3,
  clarifydoc_screens: 6, clarifydoc_file: 3, clarifydoc_trace: 8, clarifydoc_extract: 5, clarifydoc_blast_radius: 2,
  clarifydoc_data_model: 4, clarifydoc_data_flows: 6, clarifydoc_health: 5, clarifydoc_architecture: 4,
  clarifydoc_context_docs: 4, clarifydoc_impact: 5, clarifydoc_control_flow: 4, clarifydoc_analyze: 3, clarifydoc_explain: 4,
  clarifydoc_sequence: 4, clarifydoc_diff: 1, clarifydoc_export: 1, clarifydoc_facts: 4,
};

afterEach(() => {
  delete process.env.CLARIFYDOC_MCP_LOG;
});

describe("what a session pays up front", () => {
  it("keeps tools/list and the instructions under the budget", async () => {
    const { list, instructions } = await upFront();
    const bytes = list + Buffer.byteLength(instructions);
    expect(bytes, `tools/list + instructions = ${bytes} bytes`).toBeLessThan(BUDGET_BYTES);
    expect(list, `tools/list = ${list} bytes`).toBeLessThanOrEqual(TOOLS_LIST_BYTES);
    expect(instructions.length, `instructions = ${instructions.length} characters`).toBeLessThanOrEqual(INSTRUCTIONS_CHARS);
  });

  it("says when to use each tool in one sentence, and lists every argument", async () => {
    const { server } = buildMcpServer({ projectRoot: tmpdir(), allowAnalyze: false, allowColdStart: false });
    const list = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as { result: { tools: Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }> } };
    for (const t of list.result.tools) {
      expect(t.description, t.name).toMatch(/^Use /);
      // Every argument a tool takes is still in its schema: the cut is in words, never in capability.
      expect(Object.keys(t.inputSchema.properties ?? {}).length, t.name).toBe(ARGUMENTS[t.name]);
    }
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
