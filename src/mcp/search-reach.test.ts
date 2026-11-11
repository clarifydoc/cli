import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { buildMcpServer } from "./server.js";
import { sectionBytes } from "./protocol.js";

const QUERIES = ["player", "club", "api", "service", "get", "controller", "create", "list", "db", "route"];
const REACH = "  reached from: ";

async function search(server: ReturnType<typeof buildMcpServer>["server"], query: string): Promise<string[]> {
  const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_search", arguments: { query, limit: 50 } } })) as { result: { content: Array<{ text: string }> } };
  return res.result.content[0]!.text.split("\n");
}

const build = () => buildMcpServer({ projectRoot: resolve("test-fixtures/sample-backend"), analysisDir: resolve("test-output/sample-backend"), allowAnalyze: false, allowColdStart: false });

describe("search: reached-from line", () => {
  it("is display only: hit order is the same with and without reach data", async () => {
    const { server, store } = build();
    const loaded = await store.load();
    const withReach: Record<string, string[]> = {};
    for (const q of QUERIES) withReach[q] = await search(server, q);
    // The same server and analysis, with every file's reach taken away.
    const taken = new Map<{ traceImpact?: unknown }, unknown>();
    for (const b of loaded.summary.blastRadius ?? []) {
      taken.set(b, b.traceImpact);
      delete b.traceImpact;
    }
    let shown = 0;
    try {
      for (const q of QUERIES) {
        const bare = await search(server, q);
        shown += withReach[q]!.filter((l) => l.startsWith(REACH)).length;
        expect(bare.some((l) => l.startsWith(REACH))).toBe(false);
        expect(withReach[q]!.filter((l) => !l.startsWith(REACH))).toEqual(bare);
      }
    } finally {
      for (const [b, t] of taken) b.traceImpact = t;
    }
    expect(shown).toBeGreaterThan(0);
  });

  it("names at most three routes or screens and counts the rest", async () => {
    const { server } = build();
    for (const q of QUERIES) {
      for (const line of await search(server, q)) {
        if (!line.startsWith(REACH)) continue;
        const body = line.slice(REACH.length).replace(/ \(\+\d+\)$/, "");
        expect(body.split(", ").length).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("log: bytes per section", () => {
  it("splits an answer at its headings, skipping fenced code", () => {
    const text = "intro\n\n## Callers\n- a\n- b\n\n## Data\n```\n# not a heading\n```\n## Callers\n- c";
    const s = sectionBytes(text);
    expect(Object.keys(s)).toEqual(["(lead)", "Callers", "Data"]);
    expect(Object.values(s).reduce((a, b) => a + b, 0)).toBe(Buffer.byteLength(text, "utf8") + 1);
  });
});
