import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { analyze } from "../core/analyzer.js";
import { buildMcpServer } from "./server.js";

/**
 * Lines are quoted only from the text the analysis read: a file whose hash no
 * longer matches the manifest has its definitions looked up again by name, and
 * when the name is gone the lines are said to be unverified. Candidate lists
 * put the files git tracks first and mark the others.
 */
describe("snippet freshness", () => {
  let dir: string;
  let call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  const file = async (path: string, text: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", ...args], { cwd: dir, stdio: "pipe" });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-fresh-"));
    await file("package.json", '{"name":"garage","version":"1.0.0"}');
    await file("src/garage.ts", "export function park(car: string): string {\n  return car;\n}\n\nexport function wash(car: string): string {\n  return car;\n}\n");
    await file("src/pitlane.ts", "export function refuel(car: string): string {\n  return car;\n}\n");
    await file("src/paddock.ts", "export function tow(car: string): string {\n  return car;\n}\n");
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "garage");
    // A scratch copy git does not track, defining the same name.
    await file("src/garage-copy.ts", "export function park(car: string): string {\n  return car + '!';\n}\n");
    // Incremental, as the CLI and the server run it: that is what writes the manifest.
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false, incremental: true });
    const { server } = buildMcpServer({ projectRoot: dir, analysisDir: join(dir, ".clarifydoc"), allowAnalyze: false, allowColdStart: false });
    call = async (name, args) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    };
    // After the analysis: two lines added above `wash`, `refuel` renamed, `tow`'s file deleted.
    await file("src/garage.ts", "export function park(car: string): string {\n  return car;\n}\n\n// Washing.\nconst SOAP = 1;\n\nexport function wash(car: string): string {\n  return car + SOAP;\n}\n");
    await file("src/pitlane.ts", "export function refill(car: string): string {\n  return car;\n}\n");
    await rm(join(dir, "src/paddock.ts"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds a definition again by name in a file that changed since the analysis", async () => {
    const text = await call("clarifydoc_extract", { symbol: "wash", file: "src/garage.ts", depth: 0 });
    expect(text).toMatch(/^## wash\(\) — src\/garage\.ts:8-10/m);
    expect(text).toContain("return car + SOAP;");
    expect(text).toContain("definitions found again by name in the current text: src/garage.ts");
  });

  it("says the lines are unverified when the name is gone", async () => {
    const text = await call("clarifydoc_extract", { symbol: "refuel", file: "src/pitlane.ts", depth: 0 });
    expect(text).toContain("⚠ Lines unverified: the file changed since the analysis and no definition of this name is in it now.");
  });

  it("quotes nothing from a file removed since the analysis", async () => {
    const text = await call("clarifydoc_extract", { symbol: "tow", file: "src/paddock.ts", depth: 0 });
    expect(text).toContain("removed since the analysis, not quoted: src/paddock.ts");
    expect(text).not.toContain("```");
  });

  it("lists the tracked definition first and marks the untracked one", async () => {
    const text = await call("clarifydoc_extract", { symbol: "park" });
    const rows = text.split("\n").filter((l) => l.startsWith("- "));
    expect(rows[0]).toMatch(/^- park\(\) src\/garage\.ts:1 → /);
    expect(rows[1]).toMatch(/^- park\(\) src\/garage-copy\.ts:1 \(untracked\) → /);
  });
});
