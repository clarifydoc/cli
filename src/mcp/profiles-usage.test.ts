import { describe, it, expect } from "vitest";
import { join } from "path";
import { CORE_TOOLS, buildMcpServer } from "./server.js";
import { rewriteHiddenTools } from "./hidden-tools.js";
import { latencySection, percentile, renderUsage, toolLatency, usageLine } from "./usage.js";

const config = {
  projectRoot: join("test-fixtures", "sample-backend"),
  analysisDir: join("test-output", "sample-backend"),
  allowAnalyze: false,
  allowColdStart: false,
};

async function listed(tools?: string) {
  const { server } = buildMcpServer({ ...config, tools });
  const list = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: Array<{ name: string }> } };
  const init = (await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} })) as { result: { instructions: string } };
  return { names: list.result.tools.map((t) => t.name), bytes: JSON.stringify(list.result).length, instructions: init.result.instructions, server };
}

describe("tool profiles", () => {
  it("lists the core set, says so in the instructions, and costs less up front", async () => {
    const all = await listed();
    const core = await listed("core");
    expect(core.names).toEqual([...CORE_TOOLS].sort((a, b) => all.names.indexOf(a) - all.names.indexOf(b)));
    expect(core.bytes).toBeLessThan(all.bytes / 2);
    expect(core.instructions).toContain("narrower tool set: clarifydoc_status, clarifydoc_search");
    expect(all.instructions).not.toContain("narrower tool set");

    const named = await listed("search, clarifydoc_routes");
    expect(named.names).toEqual(["clarifydoc_search", "clarifydoc_routes"]);
    const res = (await named.server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "clarifydoc_trace", arguments: {} } })) as { error?: { message: string } };
    expect(res.error?.message).toContain("Unknown tool: clarifydoc_trace");
  });

  it("points at an unlisted tool as `clarifydoc ask`, in answers, instructions and prompts", async () => {
    const call = async (server: Awaited<ReturnType<typeof listed>>["server"], name: string, args: Record<string, unknown>) => {
      const res = (await server.handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: args } })) as { result: { content: Array<{ text: string }> } };
      return res.result.content[0]!.text;
    };
    const core = await listed("core");
    const full = await listed();
    const hiddenName = new RegExp(`\\b(${full.names.filter((n) => !core.names.includes(n)).join("|")})\\b`);

    // Every answer of a core tool, over a few shapes, names no tool the session lacks.
    const probes: Array<[string, Record<string, unknown>]> = [
      ["clarifydoc_search", { query: "zzzz-no-such-thing" }],
      ["clarifydoc_explain", { subject: "routes/players.ts" }],
      ["clarifydoc_file", { path: "routes/players.ts" }],
      ["clarifydoc_status", {}],
    ];
    let askLines = 0;
    for (const [name, args] of probes) {
      const text = await call(core.server, name, args);
      expect(text).not.toMatch(hiddenName);
      askLines += (text.match(/clarifydoc ask [a-z-]+/g) ?? []).length;
      // The full list says it the old way.
      expect(await call(full.server, name, args)).not.toMatch(/clarifydoc ask /);
    }
    expect(askLines).toBeGreaterThan(0);
    expect(await call(core.server, "clarifydoc_file", { path: "routes/players.ts" })).toContain('clarifydoc ask blast-radius path="routes/players.ts"');
    expect(await call(full.server, "clarifydoc_file", { path: "routes/players.ts" })).toContain('clarifydoc_blast_radius path="routes/players.ts"');

    // Instructions: unlisted tools become the shell form, listed ones stay.
    expect(core.instructions).not.toMatch(hiddenName);
    expect(core.instructions).toContain("clarifydoc ask routes");
    expect(core.instructions).toContain("clarifydoc_explain");
    expect(full.instructions).toContain("clarifydoc_routes");

    // Prompts, the same way.
    const prompt = async (s: typeof core.server) => {
      const res = (await s.handleMessage({ jsonrpc: "2.0", id: 6, method: "prompts/get", params: { name: "trace-feature", arguments: { feature: "players" } } })) as { result?: { messages: Array<{ content: { text: string } }> } };
      return res.result?.messages[0]?.content.text ?? "";
    };
    const corePrompt = await prompt(core.server);
    expect(corePrompt).toContain("clarifydoc ask data-flows");
    expect(corePrompt).toContain("clarifydoc_search");
    expect(await prompt(full.server)).toContain("clarifydoc_data_flows");
  });

  it("rewrites only hidden names, keeping the arguments", () => {
    const hidden = new Set(["clarifydoc_blast_radius", "clarifydoc_routes"]);
    expect(rewriteHiddenTools('Next: clarifydoc_blast_radius path="a.ts" · clarifydoc_trace symbol=X · clarifydoc_routes_extra', hidden)).toBe(
      'Next: clarifydoc ask blast-radius path="a.ts" · clarifydoc_trace symbol=X · clarifydoc_routes_extra',
    );
    expect(rewriteHiddenTools("clarifydoc_routes", new Set())).toBe("clarifydoc_routes");
  });

  it("refuses a name no tool has, listing what there is", () => {
    expect(() => buildMcpServer({ ...config, tools: "serach" })).toThrow(/Unknown tool for --tools: clarifydoc_serach\. Known: core, all, or status, search/);
  });
});

describe("session usage", () => {
  it("records each call in order and serves it as a resource", async () => {
    const { server } = buildMcpServer(config);
    const read = async () => {
      const res = (await server.handleMessage({ jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "clarifydoc://session/usage" } })) as { result: { contents: Array<{ text: string }> } };
      return res.result.contents[0]!.text;
    };
    expect(await read()).toContain("No tool calls yet");

    const callTool = (id: number, name: string, args: Record<string, unknown>) =>
      server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    await callTool(1, "clarifydoc_routes", { limit: 2 });
    await callTool(2, "clarifydoc_search", { query: "zzzz-no-such-thing" });
    await callTool(3, "clarifydoc_routes", { paths: "/x" });

    const calls = server.usage();
    expect(calls.map((c) => c.tool)).toEqual(["clarifydoc_routes", "clarifydoc_search", "clarifydoc_routes"]);
    expect(calls[0]).toMatchObject({ isError: false, empty: false });
    expect(calls[0]!.chars).toBeGreaterThan(0);
    expect(calls[1]).toMatchObject({ isError: false, empty: true });
    expect(calls[2]).toMatchObject({ isError: true });

    const text = await read();
    expect(text).toMatch(/^# Session usage\n\n3 calls \(routes ×2, search ×1\), [\d.k]+ chars, 1 error, 1 empty — about/);
    expect(text).toContain("- clarifydoc_routes ×2 —");
    expect(text).toMatch(/\n1\. routes — [\d.k]+ chars, \d+ ms\n2\. search — [\d.k]+ chars, \d+ ms \(empty\)\n3\. routes — 0 chars, 0 ms \(failed\)$/);
  });

  it("says one line for a log, and caps the list in order", () => {
    expect(usageLine([])).toBe("no tool calls");
    const many = Array.from({ length: 60 }, (_, i) => ({ tool: `clarifydoc_t${i % 7}`, chars: 1500, ms: 1, isError: false, empty: false }));
    expect(usageLine(many)).toMatch(/^60 calls \(t0 ×9, t1 ×9, t2 ×9, t3 ×9, t4 ×8, …\), 90k chars$/);
    const text = renderUsage(many);
    expect(text).toContain("## In order (the last 50 of 60)");
    expect(text).toContain("\n11. t3 — 1.5k chars");
    expect(text).not.toContain("\n10. ");
  });
});

describe("tool latency percentiles", () => {
  it("takes the nearest rank", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([10, 20], 50)).toBe(10);
    expect(percentile([10, 20], 90)).toBe(20);
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 90)).toBe(9);
    expect(percentile(ten, 100)).toBe(100);
  });

  it("sums per tool, slowest first, and stays silent with no calls", () => {
    const rec = (tool: string, ms: number) => ({ tool, chars: 1, ms, isError: false, empty: false });
    const calls = [rec("clarifydoc_a", 5), rec("clarifydoc_b", 50), rec("clarifydoc_a", 15), rec("clarifydoc_a", 10)];
    expect(toolLatency(calls)).toEqual([
      { tool: "clarifydoc_b", calls: 1, p50: 50, p90: 50 },
      { tool: "clarifydoc_a", calls: 3, p50: 10, p90: 15 },
    ]);
    expect(latencySection(calls)).toEqual(["## Tool latency (this session)", "- b ×1 — p50 50 ms, p90 50 ms", "- a ×3 — p50 10 ms, p90 15 ms"]);
    expect(latencySection([])).toEqual([]);
    const many = Array.from({ length: 13 }, (_, i) => rec(`clarifydoc_t${i}`, i));
    expect(latencySection(many)).toHaveLength(12);
    expect(latencySection(many).at(-1)).toBe("  … 3 more tools");
  });

  it("shows in clarifydoc_status once tools were called", async () => {
    const { server } = buildMcpServer(config);
    const callTool = async (id: number, name: string, args: Record<string, unknown> = {}) =>
      ((await server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(await callTool(1, "clarifydoc_status")).not.toContain("Tool latency");
    await callTool(2, "clarifydoc_routes", { limit: 2 });
    expect(await callTool(3, "clarifydoc_status")).toMatch(/## Tool latency \(this session\)\n- (status|routes) ×1 — p50 \d+ ms, p90 \d+ ms/);
  });
});
