/** `clarifydoc_extract` on two nested namesakes of one file: the bare name finds both, an owner path finds one. */
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
  root = await mkdtemp(join(tmpdir(), "clarifydoc-extract-owner-"));
  const side = (name: string, n: number) => [`class ${name}:`, "    class Builder:", "        def build(self):", `            return ${n}`, ""];
  const source = [...side("Left", 1), ...side("Right", 2), "def go():", "    return Right.Builder().build()", ""].join("\n");
  await writeFile(join(root, "nested.py"), source, "utf-8");
  ({ server } = buildMcpServer({ projectRoot: root, analysisDir: join(root, ".clarifydoc", basename(root)), allowAnalyze: true, allowColdStart: true }));
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("clarifydoc_extract with owner-qualified ids", () => {
  it("offers both nested methods for the bare name, spelled by their owner paths", async () => {
    const text = await extract({ symbol: "Builder.build", file: "nested.py" });
    expect(text).toContain("return 1");
    expect(text).toContain("return 2");
  });

  it("finds exactly one for an owner path", async () => {
    const text = await extract({ symbol: "Right.Builder.build", file: "nested.py" });
    expect(text).toContain("return 2");
    expect(text).not.toContain("return 1");
  });
});
