import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../core/analyzer.js";
import { loadReportSummary } from "../core/report-payload.js";
import { buildMcpServer } from "./server.js";

/**
 * A team rule that names no file cannot fail: analyze says so, the summary
 * keeps every rule's verdict, and `clarifydoc_health category=layers` lists
 * them all, the ones that hold included.
 */
describe("team rule verdicts", () => {
  let dir: string;
  let warned: string;
  let call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-rules-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league","version":"1.0.0"}');
    await file("src/clubs/club.ts", 'import { kickoff } from "../matches/match";\nexport const club = () => kickoff();\n');
    await file("src/matches/match.ts", "export const kickoff = () => 1;\n");
    await file(
      ".clarifydoc/config.json",
      JSON.stringify({
        rules: [
          { name: "matches stay below clubs", from: ["src/matches/**"], to: ["src/clubs/**"] },
          { name: "clubs keep off matches", from: ["src/clubs/**"], to: ["src/matches/**"], severity: "warn" },
          { name: "garage keeps off pitlane", from: ["src/garage/**"], to: ["src/pitlane/**"] },
        ],
      }),
    );
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
      warned = spy.mock.calls.flat().join("\n");
    } finally {
      spy.mockRestore();
    }
    const { server } = buildMcpServer({ projectRoot: dir, analysisDir: join(dir, ".clarifydoc"), allowAnalyze: false, allowColdStart: false });
    call = async (name, args) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    };
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps each rule's verdict, and warns about the vacuous one", async () => {
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    expect(summary.ruleVerdicts?.map((r) => [r.name, r.verdict, r.violations])).toEqual([
      ["matches stay below clubs", "holds", 0],
      ["clubs keep off matches", "violated", 1],
      ["garage keeps off pitlane", "vacuous", 0],
    ]);
    expect(warned).toContain('rule "garage keeps off pitlane" is vacuous');
    expect(summary.provenance?.config.warnings.join("\n")).toContain('rule "garage keeps off pitlane" is vacuous');
  });

  it("health category=layers lists every rule with its verdict", async () => {
    const text = await call("clarifydoc_health", { category: "layers" });
    expect(text).toContain("## Rules (3)");
    expect(text).toContain("- matches stay below clubs: holds");
    expect(text).toContain("- clubs keep off matches (warn): violated — 1 import");
    expect(text).toContain("- garage keeps off pitlane: vacuous — its `from` and `to` match no analyzed file");
  });
});
