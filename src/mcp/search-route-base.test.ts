/**
 * A route mounted under a conventional base (`/api`) is found by the path its controller writes
 * (`/players/{player_id}`), as a client call naming it below the base is joined to it.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { buildMcpServer } from "./server.js";

async function firstHit(query: string): Promise<string> {
  const { server } = buildMcpServer({
    projectRoot: resolve("test-fixtures/sample-python-api"),
    analysisDir: resolve("test-output/sample-python-api"),
    allowAnalyze: false,
    allowColdStart: false,
  });
  const res = (await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "clarifydoc_search", arguments: { query, kinds: ["route"], limit: 5 } },
  })) as { result: { content: Array<{ text: string }> } };
  // The first hit: hits are `- [kind] …` lines below the heading.
  return res.result.content[0]!.text.split("\n").find((l) => l.startsWith("- [")) ?? "";
}

describe("search: a route below its conventional base", () => {
  it("is found by the path its controller writes", async () => {
    expect(await firstHit("/auth/login")).toContain("/api/auth/login");
    expect(await firstHit("/players/{player_id}")).toContain("/api/players/{player_id}");
  });

  it("is still found by its full path", async () => {
    expect(await firstHit("/api/auth/login")).toContain("/api/auth/login");
  });
});
