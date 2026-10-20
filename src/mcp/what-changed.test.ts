/**
 * After a re-run, clarifydoc_analyze says what that run changed — the files
 * and what they reach — so an agent does not have to ask for the impact of an
 * edit it just made. A run with no prior one has nothing to compare and says
 * nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFile, cp, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-what-changed-"));
  await cp(resolve("test-fixtures/sample-backend"), join(dir, "proj"), { recursive: true });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("analyze reply", () => {
  it("names the files the run re-read and the routes they reach", async () => {
    const { server } = buildMcpServer({ projectRoot: join(dir, "proj"), analysisDir: join(dir, "out", "proj"), allowAnalyze: true, analyzeSettings: { gitHistory: false }, log: () => {} });
    const call = async (id: number) => {
      const res = (await server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "clarifydoc_analyze", arguments: {} } })) as { result: { content: Array<{ text: string }> } };
      return res.result.content[0]!.text;
    };

    const first = await call(1);
    expect(first).toMatch(/^Analysis complete in/);
    expect(first).not.toContain("This run:");

    await appendFile(join(dir, "proj", "controllers", "authController.ts"), "\nexport const touched = 1;\n");
    const second = await call(2);
    expect(second).toContain("This run: 1 file changed (controllers/authController.ts)");
    expect(second).toMatch(/reaching \d+ routes? \(POST \/[^)]*\)/);
    expect(second).toContain("clarifydoc_impact gives the detail.");
  }, 120_000);
});
