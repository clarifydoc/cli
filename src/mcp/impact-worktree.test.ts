/**
 * clarifydoc_impact reads a change made in a linked worktree of the analyzed repository, and refuses a path that
 * belongs to another one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("clarifydoc_impact worktree=", () => {
  let dir = "";
  let server: ReturnType<typeof buildMcpServer>["server"];
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
  const impact = async (args: Record<string, unknown>) => {
    const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_impact", arguments: args } })) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { text: res.result.content[0]!.text, isError: !!res.result.isError };
  };

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "clarifydoc-impact-wt-")));
    cpSync(resolve("test-fixtures/sample-backend"), join(dir, "main"), { recursive: true });
    git(join(dir, "main"), "init", "-q");
    git(join(dir, "main"), "add", "-A");
    git(join(dir, "main"), "commit", "-qm", "init");
    git(join(dir, "main"), "worktree", "add", "-q", join(dir, "club-change"), "-b", "club-change");
    mkdirSync(join(dir, "elsewhere"));
    git(join(dir, "elsewhere"), "init", "-q");
    const built = buildMcpServer({ projectRoot: join(dir, "main"), analysisDir: join(dir, "out", "main"), allowAnalyze: true, analyzeSettings: { gitHistory: false }, log: () => {} });
    server = built.server;
    await server.handleMessage({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "clarifydoc_analyze", arguments: {} } });
    appendFileSync(join(dir, "club-change", "controllers", "authController.ts"), "\nexport const touched = 1;\n");
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports a change made only in the worktree, and says where it read it", async () => {
    const own = await impact({ base: "HEAD" });
    expect(own.text).toContain("No changed files");
    const other = await impact({ worktree: join(dir, "club-change") });
    expect(other.isError).toBe(false);
    expect(other.text).toContain(`Changes read from the worktree ${join(dir, "club-change")}`);
    expect(other.text).toContain("controllers/authController.ts");
  }, 60_000);

  it("reads a proposed edit against the worktree's file", async () => {
    const { text, isError } = await impact({ worktree: join(dir, "club-change"), proposed: [{ file: "controllers/authController.ts", content: "export const x = 1;\n" }] });
    expect(isError).toBe(false);
    expect(text).toContain("Changes read from the worktree");
    expect(text).toContain("Nothing was written");
  }, 60_000);

  it("refuses a path that belongs to another repository, or is no directory", async () => {
    const foreign = await impact({ worktree: join(dir, "elsewhere") });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain("another repository");
    const missing = await impact({ worktree: join(dir, "nope") });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("not a directory");
  });
});
