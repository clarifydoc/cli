/** `clarifydoc_extract` on an overloaded method: the name finds every overload, the typed id one. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { buildMcpServer } from "./server.js";

let root = "";
let server: ReturnType<typeof buildMcpServer>["server"];

async function extract(args: Record<string, unknown>): Promise<string> {
  const r = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_extract", arguments: args } })) as { result: { content: Array<{ text: string }> } };
  return r.result.content[0]!.text;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "clarifydoc-extract-overloads-"));
  const source = [
    "class Squad {", "    int pick() { return 10; }", "    int pick(int n) { return 20 + n; }", "    int pick(String who) { return 30; }", "}", "",
    "class Garage {", "    int go(Squad s) {", "        return s.pick(1);", "    }", "}", "",
  ].join("\n");
  await writeFile(join(root, "Squad.java"), source, "utf-8");
  ({ server } = buildMcpServer({ projectRoot: root, analysisDir: join(root, ".clarifydoc", basename(root)), allowAnalyze: true, allowColdStart: true }));
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("clarifydoc_extract with overload ids", () => {
  it("lists every overload, with its parameter types, for the bare name", async () => {
    const text = await extract({ symbol: "Squad.pick" });
    expect(text).toContain("Squad.pick(int)");
    expect(text).toContain("Squad.pick(String)");
    expect(text).toContain("Squad.pick()");
  });
  it("finds exactly one for the typed id", async () => {
    const text = await extract({ symbol: "Squad.pick(int)", file: "Squad.java" });
    expect(text).toContain("20 + n");
    expect(text).not.toContain("return 30");
  });
});
