/**
 * A file edited since the analysis says so where its facts are read —
 * clarifydoc_file, clarifydoc_blast_radius (the file and its listed
 * dependents) and clarifydoc_explain — judged per file from the manifest's
 * mtime and hash, so an agent knows which line numbers to distrust.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFile, cp, mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";
import { EXTRACTOR_VERSION, hashFile } from "../core/manifest.js";

let dir = "";
const proj = () => join(dir, "proj");
const out = () => join(dir, "out");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-file-freshness-"));
  await cp(resolve("test-fixtures/sample-backend"), proj(), { recursive: true });
  await cp(resolve("test-output/sample-backend"), out(), { recursive: true });
  const files = ["controllers/authController.ts", "db/prisma.ts", "middleware/auth.ts", "routes/auth.ts", "routes/players.ts", "routes/reports.ts", "server.ts", "services/authService.ts", "services/playerService.ts"];
  const entries: Record<string, { mtime: number; sha256: string }> = {};
  for (const f of files) {
    const abs = join(proj(), f);
    entries[f] = { mtime: (await stat(abs)).mtimeMs, sha256: await hashFile(abs) };
  }
  await writeFile(join(out(), "manifest.json"), JSON.stringify({ version: 1, extractorVersion: EXTRACTOR_VERSION, entries }));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function call(server: ReturnType<typeof buildMcpServer>["server"], name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { content: Array<{ text: string }> } };
  return res.result.content[0]!.text;
}

describe("per-file freshness", () => {
  it("says nothing while the files match the manifest, and names the one edited after", async () => {
    const { server } = buildMcpServer({ projectRoot: proj(), analysisDir: out(), allowAnalyze: false, allowColdStart: false, log: () => {} });
    expect(await call(server, "clarifydoc_file", { path: "middleware/auth.ts" })).not.toContain("since the analysis");

    await appendFile(join(proj(), "middleware", "auth.ts"), "\nexport const touched = 1;\n");

    const file = await call(server, "clarifydoc_file", { path: "middleware/auth.ts" });
    expect(file.split("\n")[1]).toMatch(/^⚠ middleware\/auth\.ts changed since the analysis/);
    // Another file stays unmarked.
    expect(await call(server, "clarifydoc_file", { path: "services/authService.ts" })).not.toContain("since the analysis");

    const blast = await call(server, "clarifydoc_blast_radius", { path: "middleware/auth.ts" });
    expect(blast).toContain("⚠ middleware/auth.ts changed since the analysis");
    const dependentOf = await call(server, "clarifydoc_blast_radius", { path: "services/authService.ts" });
    expect(dependentOf).toMatch(/- middleware\/auth\.ts \(changed since the analysis\)/);

    const explain = await call(server, "clarifydoc_explain", { subject: "middleware/auth.ts" });
    // Said once, under the heading, not again in each part.
    expect(explain.match(/changed since the analysis —/g)).toHaveLength(1);
    expect(explain.split("\n")[1]).toMatch(/^⚠ middleware\/auth\.ts changed/);
  });

  it("calls a deleted file removed", async () => {
    const { server } = buildMcpServer({ projectRoot: proj(), analysisDir: out(), allowAnalyze: true, allowColdStart: false, log: () => {} });
    await rm(join(proj(), "routes", "reports.ts"));
    const file = await call(server, "clarifydoc_file", { path: "routes/reports.ts" });
    expect(file).toContain("⚠ routes/reports.ts was removed or renamed since the analysis");
    expect(file).toContain("clarifydoc_analyze refreshes it");
  });
});
