import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EXTRACTOR_VERSION } from "./manifest.js";
import { mainWorktreeAnalysisDir, seedFromMainWorktree } from "./worktree-seed.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("seedFromMainWorktree", () => {
  let dir: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
  const writeAnalysis = (out: string, version = EXTRACTOR_VERSION) => {
    mkdirSync(join(out, "src"), { recursive: true });
    writeFileSync(join(out, "src", "a.ts.json"), '{"filePath":"src/a.ts"}');
    writeFileSync(join(out, "manifest.json"), JSON.stringify({ version: 1, extractorVersion: version, entries: { "src/a.ts": { mtime: 123, sha256: "abc" }, "src/gone.ts": { mtime: 1, sha256: "x" } } }));
  };

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-seed-")));
    mkdirSync(join(dir, "main", "src"), { recursive: true });
    writeFileSync(join(dir, "main", "src", "a.ts"), "export const a = 1;\n");
    git(join(dir, "main"), "init", "-q");
    git(join(dir, "main"), "add", "-A");
    git(join(dir, "main"), "commit", "-qm", "init");
    git(join(dir, "main"), "worktree", "add", "-q", join(dir, "feature"), "-b", "feature");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("copies the main checkout's per-file JSON and a manifest that forces a hash of every file", async () => {
    writeAnalysis(join(dir, "main", ".clarifydoc", "main"));
    const out = join(dir, "feature", ".clarifydoc", "feature");
    expect(await mainWorktreeAnalysisDir(join(dir, "feature"), out)).toBe(join(dir, "main", ".clarifydoc", "main"));
    const seed = await seedFromMainWorktree(join(dir, "feature"), out);
    expect(seed?.files).toBe(1);
    expect(readFileSync(join(out, "src", "a.ts.json"), "utf8")).toContain("src/a.ts");
    // The entry whose JSON was missing is dropped; the mtime never vouches for a file.
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).entries).toEqual({ "src/a.ts": { mtime: -1, sha256: "abc" } });
    // Once it has a manifest of its own, it is never seeded again.
    expect(await seedFromMainWorktree(join(dir, "feature"), out)).toBeNull();
  });

  it("does nothing in the main checkout, for output outside the project, or from another extractor version", async () => {
    expect(await mainWorktreeAnalysisDir(join(dir, "main"), join(dir, "main", ".clarifydoc", "main"))).toBeNull();
    expect(await mainWorktreeAnalysisDir(join(dir, "feature"), join(dir, "elsewhere"))).toBeNull();
    writeAnalysis(join(dir, "main", ".clarifydoc", "main"), "0.0.1");
    const out = join(dir, "feature", ".cd2", "feature");
    mkdirSync(join(dir, "main", ".cd2"), { recursive: true });
    writeAnalysis(join(dir, "main", ".cd2", "main"), "0.0.1");
    expect(await seedFromMainWorktree(join(dir, "feature"), out)).toBeNull();
    expect(existsSync(join(out, "manifest.json"))).toBe(false);
  });
});
