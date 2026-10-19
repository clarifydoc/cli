import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * An incremental run with nothing changed — no file, option, config or git
 * state — stops before post-analysis and leaves the artifacts as they were;
 * anything the summary reads, tracked or not, forces a real run.
 */
describe.skipIf(!hasGit)("up-to-date early exit", () => {
  let dir: string;
  let root: string;
  let out: string;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, stdio: "ignore" });
  const run = () => analyze({ projectRoot: root, outputDir: out, incremental: true, lsp: false, gitHistory: false });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-utd-"));
    root = join(dir, "proj");
    out = join(dir, "out", "proj");
    await cp(resolve("test-fixtures/sample-microservices"), root, { recursive: true });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is up to date only when nothing the summary reads changed", async () => {
    expect((await run()).upToDate).toBeUndefined();
    const summary = await readFile(join(out, "project-summary.json"), "utf8");
    expect(JSON.parse(summary).provenance.stageTimings.map((t: { stage: string }) => t.stage)).toContain("Analyzing files");

    const again = await run();
    expect(again).toMatchObject({ upToDate: true, changedFiles: [], removedFiles: [] });
    expect(again.routeCount).toBeGreaterThan(0);
    // The artifacts stand; the latest impact says this run changed nothing.
    expect(await readFile(join(out, "project-summary.json"), "utf8")).toBe(summary);
    expect(JSON.parse(await readFile(join(out, "impact-latest.json"), "utf8")).changedFiles).toEqual([]);

    // A tracked file no per-file entry covers.
    await appendFile(join(root, "docker-compose.yml"), "# changed\n");
    expect((await run()).upToDate).toBeUndefined();
    expect((await run()).upToDate).toBe(true);
    // An untracked file.
    await writeFile(join(root, "notes.md"), "x\n");
    expect((await run()).upToDate).toBeUndefined();
    expect((await run()).upToDate).toBe(true);
  }, 120_000);
});
