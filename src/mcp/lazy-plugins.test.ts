import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../core/analyzer.js";
import { allPluginMetas, manifestFor } from "../extractors/registry.js";

/**
 * The MCP server loads language plugins lazily, but the test setup loads them
 * all up front, so a tool reaching `pluginFor()` before loading its language
 * passes every other test and fails for every user. Here the server is built
 * from a fresh module graph, with no plugin loaded — as `clarifydoc mcp` starts.
 */
describe("MCP tools on a server that loaded no plugin yet", () => {
  let dir: string;
  let call: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-lazy-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), '{"name":"garage","version":"1.0.0"}');
    await writeFile(
      join(dir, "src/garage.ts"),
      ["/** Parks one car. */", "export function park(car: string): string {", "  // Kept as text because the garage reads number plates as text.", "  return car;", "}", ""].join("\n"),
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
    vi.resetModules();
    const { buildMcpServer } = await import("./server.js");
    const { server } = buildMcpServer({ projectRoot: dir, analysisDir: join(dir, ".clarifydoc"), allowAnalyze: false, allowColdStart: false });
    call = async (name, args) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      const result = res?.result as { content: Array<{ text: string }>; isError?: boolean };
      return { text: result.content[0]!.text, isError: result.isError };
    };
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("extract quotes a definition with its doc comment", async () => {
    const { text, isError } = await call("clarifydoc_extract", { symbol: "park", file: "src/garage.ts", depth: 0 });
    expect(isError).toBeFalsy();
    expect(text).toContain("/** Parks one car. */\nexport function park");
  });

  it("explain quotes it too", async () => {
    const { text, isError } = await call("clarifydoc_explain", { subject: "park" });
    expect(isError).toBeFalsy();
    expect(text).toContain("/** Parks one car. */");
  });

  it("context docs read a file's stated reasons in its language's comment syntax", async () => {
    const { text, isError } = await call("clarifydoc_context_docs", { file: "src/garage.ts" });
    expect(isError).toBeFalsy();
    expect(text).toContain("because the garage reads number plates as text");
  });
});

/**
 * Static data a tool reads on demand lives on the always-loaded manifest, so
 * reading it never depends on which plugin bodies a process happened to load.
 */
describe("doc-comment syntax on the manifest", () => {
  it("every plugin's doc-comment syntax is the one its manifest declares", () => {
    const declaring = allPluginMetas().filter((m) => m.docComments);
    expect(declaring.length).toBeGreaterThan(20);
    for (const meta of declaring) expect(manifestFor(meta.language)?.docComments, meta.language).toBe(meta.docComments);
  });

  it("is readable before any plugin body loads", async () => {
    vi.resetModules();
    const fresh = await import("../extractors/registry.js");
    expect(() => fresh.pluginFor("python")).toThrow(/not loaded/);
    expect(fresh.manifestFor("python")?.docComments?.docstring).toBe(true);
    expect(fresh.manifestFor("typescript")?.docComments?.block?.[0]).toEqual(["/**", "*/"]);
  });
});
