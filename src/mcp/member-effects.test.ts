import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../core/analyzer.js";
import { buildMcpServer } from "./server.js";

/** `clarifydoc_trace direction=writers` and the "Writes and throws" part of `clarifydoc_explain`. */
describe("field writers and throws over MCP", () => {
  let dir: string;
  let call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-writers-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), '{"name":"league","version":"1.0.0"}');
    await writeFile(join(dir, "src/club.ts"), [
      "export class Overdrawn extends Error {}",
      "export class Club {",
      '  status = "open";',
      '  close(): void { this.status = "closed"; if (this.status) throw new Overdrawn("x"); }',
      "}",
      "export class Garage {",
      '  status = "open";',
      '  park(): void { this.status = "parked"; }',
      "}",
      "export function suspend(c: Club): void {",
      '  c.status = "suspended";',
      "}",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
    const { server } = buildMcpServer({ projectRoot: dir, analysisDir: join(dir, ".clarifydoc"), allowAnalyze: false, allowColdStart: false });
    call = async (name, args) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    };
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the writers of Club.status and not Garage.status", async () => {
    const text = await call("clarifydoc_trace", { symbol: "Club.status", direction: "writers" });
    expect(text).toContain("Who assigns Club.status — 2 writes in 2 functions");
    expect(text).toContain("- Club.close — src/club.ts:4");
    expect(text).toContain("- suspend — src/club.ts:11 (through a typed receiver)");
    expect(text).not.toContain("park");
  });

  it("lists who throws an exception class", async () => {
    const text = await call("clarifydoc_trace", { symbol: "Overdrawn", direction: "writers" });
    expect(text).toContain("- Club.close — src/club.ts:4");
  });

  it("says what exists on a miss", async () => {
    const text = await call("clarifydoc_trace", { symbol: "Club.budget", direction: "writers" });
    expect(text).toContain("No assignment to `Club.budget`");
    expect(text).toContain("Garage.status");
  });

  it("explains a function's writes and throws", async () => {
    const text = await call("clarifydoc_explain", { subject: "Club.close" });
    expect(text).toContain("## Writes and throws");
    expect(text).toContain("Club.status at src/club.ts:4");
    expect(text).toContain("Overdrawn at src/club.ts:4 — project class in src/club.ts");
  });
});
