import { describe, it, expect } from "vitest";
import { join } from "path";
import { CORE_TOOLS, buildMcpServer } from "./server.js";
import { renderUsage, usageLine } from "./usage.js";

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
