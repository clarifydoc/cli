/**
 * An MCP server whose analysis directory is missing, unreadable or damaged answers every tool with the
 * path and the command that fixes it; it never throws past the protocol layer or exits.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { buildMcpServer } from "./server.js";

let root = "";
let out = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clarifydoc-noan-"));
  out = join(root, "reports");
});
afterEach(async () => {
  await chmod(out, 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

type Reply = { result: { content: Array<{ text: string }>; isError?: boolean } };
const NAMES = ["status", "search", "routes", "explain", "extract", "file", "health", "architecture", "data_model", "screens", "services"];
const ARGS: Record<string, Record<string, unknown>> = { search: { query: "Match" }, extract: { symbol: "Match" }, file: { path: "a.py" }, explain: { subject: "Match" } };

async function ask(analysisDir: string, name: string): Promise<string> {
  const { server } = buildMcpServer({ projectRoot: root, analysisDir, allowAnalyze: false, allowColdStart: false });
  const r = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `clarifydoc_${name}`, arguments: ARGS[name] ?? {} } })) as Reply;
  return r.result.content[0]!.text;
}

describe("MCP with no usable analysis", () => {
  it("every tool names the path and the analyze command for a missing directory", async () => {
    const dir = join(out, basename(root));
    for (const name of NAMES) {
      const text = await ask(dir, name);
      expect(text, name).toContain(join(dir, "project-summary.json"));
      expect(text, name).toContain(`clarifydoc analyze ${root} -o ${out}`);
    }
  });

  it("says the directory cannot be read when permissions refuse it, with the command", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await mkdir(join(out, basename(root)), { recursive: true });
    await chmod(out, 0o000);
    const dir = join(out, basename(root));
    for (const name of NAMES) {
      const text = await ask(dir, name);
      expect(text, name).toMatch(/cannot be read \(EACCES\)/);
      expect(text, name).toContain(`clarifydoc analyze ${root} -o ${out}`);
    }
  });

  it("answers with the fix for a summary that is not valid JSON", async () => {
    const dir = join(out, basename(root));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "project-summary.json"), "{ not json", "utf-8");
    const text = await ask(dir, "search");
    expect(text).toMatch(/cannot be read/);
    expect(text).toContain(`clarifydoc analyze ${root} -o ${out}`);
  });
});
