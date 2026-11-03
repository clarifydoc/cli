/**
 * An analysis written by a newer engine than the server runs is not stale —
 * the server is. Every answer says so, and clarifydoc_analyze refuses to write
 * the older reading over it. An older analysis stays stale as before.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";
import { EXTRACTOR_VERSION, hashFile } from "../core/manifest.js";

let dir = "";
const proj = () => join(dir, "proj");
const out = () => join(dir, "out");
let entries: Record<string, { mtime: number; sha256: string }> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-engine-older-"));
  await cp(resolve("test-fixtures/sample-backend"), proj(), { recursive: true });
  await cp(resolve("test-output/sample-backend"), out(), { recursive: true });
  for (const f of ["middleware/auth.ts", "server.ts"]) {
    const abs = join(proj(), f);
    entries[f] = { mtime: (await stat(abs)).mtimeMs, sha256: await hashFile(abs) };
  }
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeManifest = (extractorVersion: string) =>
  writeFile(join(out(), "manifest.json"), JSON.stringify({ version: 1, extractorVersion, entries }));

async function call(server: ReturnType<typeof buildMcpServer>["server"], name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { text: res.result.content[0]!.text, isError: res.result.isError === true };
}

describe("an analysis newer than the engine", () => {
  it("is reported as the server's age, never as stale, and is not rewritten", async () => {
    const [major, minor] = EXTRACTOR_VERSION.split(".").map(Number);
    const newer = `${major}.${minor! + 1}.0`;
    await writeManifest(newer);
    const before = await readFile(join(out(), "manifest.json"), "utf-8");
    const { server } = buildMcpServer({ projectRoot: proj(), analysisDir: out(), allowAnalyze: true, allowColdStart: false, log: () => {} });

    const file = await call(server, "clarifydoc_file", { path: "middleware/auth.ts" });
    expect(file.text).toContain(`⚠ Server older than the analysis: this server runs engine ${EXTRACTOR_VERSION}, older than the ${newer} that wrote the analysis`);
    expect(file.text).not.toContain("Stale:");

    const status = await call(server, "clarifydoc_status");
    expect(status.text).toContain(`older than the ${newer} that wrote the analysis`);
    expect(status.text).not.toContain("call clarifydoc_analyze with full=true");

    const analyze = await call(server, "clarifydoc_analyze", { full: true });
    expect(analyze.isError).toBe(false);
    expect(analyze.text).toContain(`Not re-analyzing: this server runs engine ${EXTRACTOR_VERSION}, older than the ${newer}`);
    expect(await readFile(join(out(), "manifest.json"), "utf-8")).toBe(before);
  });

  it("an older analysis is still stale", async () => {
    await writeManifest("0.0.1");
    const { server } = buildMcpServer({ projectRoot: proj(), analysisDir: out(), allowAnalyze: true, allowColdStart: false, log: () => {} });
    const file = await call(server, "clarifydoc_file", { path: "middleware/auth.ts" });
    expect(file.text).toContain("⚠ Stale: the extractor changed since this analysis — clarifydoc_analyze full=true refreshes it.");
    const status = await call(server, "clarifydoc_status");
    expect(status.text).toContain("the extractor changed since this analysis — call clarifydoc_analyze with full=true");
  });
});
