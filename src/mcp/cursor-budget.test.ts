import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { buildMcpServer } from "./server.js";
import { bindCursors, fitAnswer, parseCursor, revisionOf } from "./paging.js";

describe("page cursors and the answer budget", () => {
  it("reads a cursor, binds footers, and cuts at a line", () => {
    expect(parseCursor("50@3FA2C1")).toEqual({ offset: 50, revision: "3fa2c1" });
    expect(parseCursor(50)).toBeNull();
    expect(parseCursor("50")).toBeNull();
    expect(revisionOf("2026-10-20T10:00:00.000Z")).toMatch(/^[0-9a-f]{6}$/);
    expect(revisionOf("2026-10-20T10:00:00.000Z")).not.toBe(revisionOf("2026-10-20T10:00:01.000Z"));
    expect(bindCursors("next page: `offset=20`, or narrow", "abc123")).toBe('next page: `offset="20@abc123"`, or narrow');

    const text = Array.from({ length: 100 }, (_, i) => `- row ${i}`).join("\n");
    expect(fitAnswer(text, 10_000)).toBe(text);
    const cut = fitAnswer(text, 50);
    expect(cut.length).toBeLessThan(400);
    expect(cut).toMatch(/- row \d+\n\n… answer cut at ~50 tokens \(\d+ more lines left out\)/);
    expect(cut.split("\n").filter((l) => l.startsWith("- row")).every((l) => /^- row \d+$/.test(l))).toBe(true);
  });
});

describe("through the server", () => {
  const { server, store } = buildMcpServer({
    projectRoot: join("test-fixtures", "sample-backend"),
    analysisDir: join("test-output", "sample-backend"),
    allowAnalyze: false,
    allowColdStart: false,
  });
  const call = async (args: Record<string, unknown>, name = "clarifydoc_routes") => {
    const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return res.result;
  };
  afterEach(() => {
    delete process.env.CLARIFYDOC_MCP_MAX_TOKENS;
  });

  it("sends the next page as a cursor of this analysis, and says when a cursor is from another", async () => {
    const rev = revisionOf((await store.load()).summary.analyzedAt);
    const first = (await call({ limit: 2 })).content[0]!.text;
    expect(first).toContain(`next page: \`offset="2@${rev}"\``);
    expect(first).not.toMatch(/`offset=\d/);

    const second = await call({ limit: 2, offset: `2@${rev}` });
    expect(second.isError).toBeUndefined();
    expect(second.content[0]!.text).toContain("(showing 3–4 of");
    expect(second.content[0]!.text).not.toContain("re-run since that page");

    const moved = (await call({ limit: 2, offset: "2@000000" })).content[0]!.text;
    expect(moved).toMatch(/^The analysis was re-run since that page was listed: offset 2 counts into the new list/);
    expect(moved).toContain("(showing 3–4 of");
  });

  it("cuts an answer over the budget, unless the call set its own maxTokens", async () => {
    process.env.CLARIFYDOC_MCP_MAX_TOKENS = "100";
    const cut = (await call({ limit: 50 })).content[0]!.text;
    expect(cut).toMatch(/… answer cut at ~100 tokens \(\d+ more lines? left out\)\. Ask for less/);

    const own = (await call({ subject: "/api/auth/register", maxTokens: 500 }, "clarifydoc_explain")).content[0]!.text;
    expect(own).not.toContain("answer cut at");
  });
});
