import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readSourceRevision, listGitFiles } from "./source-revision.js";
import { runFingerprint } from "./run-fingerprint.js";
import { assertGitRef, endOfOptionsFor } from "./git-safe.js";
import { analysisAtRef } from "./base-ref.js";
import { gitChangedFiles, gitChangedHunks, gitUserName } from "./git-changed-files.js";
import { collectGitHistory } from "./git-history.js";
import { scanHistorySecrets } from "./history-secrets.js";

/**
 * A repository's own `.git/config` can name programs git runs: `core.fsmonitor`
 * whenever the index is read, `diff.external` and a textconv driver on every
 * diff. The repo below sets all three to a script that leaves a marker file;
 * every git call the analyzer makes must leave no marker.
 */

let root: string;
const repo = () => join(root, "repo");
const marker = () => join(root, "ran");

const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repo(), env: { ...process.env, GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_EMAIL: "t@t" }, stdio: "pipe" });

describe.skipIf(process.platform === "win32")("git calls never run a program the repository configures", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rvd-git-safe-"));
    execFileSync("git", ["init", "-q", repo()]);
    git(["config", "user.name", "t"]);
    git(["config", "user.email", "t@t"]);
    writeFileSync(join(repo(), "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo(), ".gitattributes"), "*.ts diff=evil\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    writeFileSync(join(repo(), "a.ts"), "export const a = 2;\nexport const token = 'x';\n");

    const hook = join(root, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\necho "$0 $*" >> '${marker()}'\ncat "$2" 2>/dev/null\n`);
    chmodSync(hook, 0o755);
    git(["config", "core.fsmonitor", hook]);
    git(["config", "diff.external", hook]);
    git(["config", "diff.evil.textconv", hook]);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("the fixture really runs the hook for a plain git call", () => {
    git(["status", "--porcelain"]);
    expect(existsSync(marker())).toBe(true);
    rmSync(marker());
  });

  it("source revision, file list, fingerprint, impact, history and secrets stay clean", async () => {
    expect((await readSourceRevision(repo()))?.dirty).toBe(1);
    expect(await listGitFiles(repo())).toContain("a.ts");
    expect(await runFingerprint(repo(), { options: {} })).toBeTruthy();
    expect((await gitChangedFiles(repo())).files).toContain("a.ts");
    expect((await gitChangedHunks(repo())).get("a.ts")).toBeTruthy();
    expect(await gitUserName(repo())).toBe("t");
    await collectGitHistory(repo(), ["a.ts"]);
    await scanHistorySecrets(repo());
    expect(existsSync(marker()) ? readFileSync(marker(), "utf8") : "").toBe("");
  });
});

describe("every git the CLI spawns goes through git-safe", () => {
  it("no source file spawns git without the safe config", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        // extractors/ reads spawns in analyzed code; it never runs git itself.
        if (e.isDirectory()) { if (e.name !== "extractors") walk(p); }
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && e.name !== "git-safe.ts") {
          const text = readFileSync(p, "utf8");
          if (/\b(?:execFile|execFileSync|spawn|spawnSync|run)\(\s*(?:process\.env\.CLARIFYDOC_GIT \?\? )?"git"/.test(text) && !/from "(?:\.\.?\/)+(?:core\/)?git-safe\.js"/.test(text)) offenders.push(p);
        }
      }
    };
    walk(join(__dirname, ".."));
    expect(offenders).toEqual([]);
  });
});

/** The files that spawn git and hand it no value from a flag, an MCP argument or the analyzed repository. */
const GIT_REF_FREE: Record<string, string> = {
  "core/history-secrets.ts": "log over a fixed range",
  "core/context-docs.ts": "log of paths the analysis found, after `--`",
  "core/run-fingerprint.ts": "fixed status and rev-parse arguments",
  "core/doc-history.ts": "paths the analysis found, after `--`",
  "core/git-history.ts": "dates and counts it computes itself",
  "core/changed-symbols.ts": "`diff --no-index` over two temporary files it wrote",
  "core/stated-reasons.ts": "`log -L` of a file the analysis found, after `--`",
  "core/source-revision.ts": "fixed ls-files and rev-parse arguments",
  "core/worktree-seed.ts": "fixed rev-parse and worktree list arguments",
  "mcp/impact-worktree.ts": "fixed rev-parse arguments; a caller's directory is the value of -C",
  "agents/install.ts": "`rev-parse --git-path hooks`",
};

describe("a git call that takes a caller's ref goes through assertGitRef", () => {
  it("no source file spawns git without the guard unless it is listed as ref-free", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "extractors") walk(p); }
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && e.name !== "git-safe.ts") {
          const text = readFileSync(p, "utf8");
          const rel = p.slice(join(__dirname, "..").length + 1).split("\\").join("/");
          const spawns = /\b(?:execFile|execFileSync|spawn|spawnSync|run)\(\s*(?:process\.env\.CLARIFYDOC_GIT \?\? )?"git"|\bgitText\(/.test(text);
          if (spawns && !text.includes("assertGitRef") && !(rel in GIT_REF_FREE)) offenders.push(rel);
        }
      }
    };
    walk(join(__dirname, ".."));
    expect(offenders).toEqual([]);
  });
});

describe("a ref that looks like a git option is refused", () => {
  let dir: string;
  let proj: string;
  const out = () => join(dir, "written.txt");
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rvd-git-ref-"));
    proj = join(dir, "club");
    execFileSync("git", ["init", "-q", proj]);
    writeFileSync(join(proj, "match.ts"), "export const goals = 1;\n");
    execFileSync("git", ["-C", proj, "add", "-A"]);
    execFileSync("git", ["-C", proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "kickoff"]);
    writeFileSync(join(proj, "match.ts"), "export const goals = 2;\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bad = () => [`--output=${out()}`, "-p", "--exec=touch", "-"];

  it("assertGitRef names the argument and passes ordinary refs", () => {
    expect(() => assertGitRef("--output=x", "--base")).toThrow(/--base .* starts with "-"/);
    expect(() => assertGitRef("main\n--output=x", "base")).toThrow(/control character/);
    for (const ok of ["HEAD", "main", "origin/feature/x", "v1.2.3", "HEAD~2", "a1b2c3d", "refs/pull/7/head"]) expect(assertGitRef(ok)).toBe(ok);
  });

  it("gitChangedFiles, gitChangedHunks and analysisAtRef refuse it and write nothing", async () => {
    for (const base of bad()) {
      await expect(gitChangedFiles(proj, { base })).rejects.toThrow(/starts with "-"/);
      await expect(gitChangedHunks(proj, { base })).rejects.toThrow(/starts with "-"/);
      await expect(analysisAtRef(proj, base, { cacheBase: join(dir, "base-cache") })).rejects.toThrow(/starts with "-"/);
    }
    expect(existsSync(out())).toBe(false);
  });

  it("--end-of-options is only for a git that reads it", () => {
    expect(endOfOptionsFor("git version 2.54.0 (Apple Git-157)")).toEqual(["--end-of-options"]);
    expect(endOfOptionsFor("git version 2.24.0")).toEqual(["--end-of-options"]);
    expect(endOfOptionsFor("git version 3.0.1")).toEqual(["--end-of-options"]);
    expect(endOfOptionsFor("git version 2.23.9")).toEqual([]);
    expect(endOfOptionsFor("git version 1.9.1")).toEqual([]);
    expect(endOfOptionsFor("something else")).toEqual([]);
    expect(endOfOptionsFor(null)).toEqual([]);
  });

  it("an ordinary base still reads the diff", async () => {
    expect((await gitChangedFiles(proj, { base: "HEAD" })).files).toEqual(["match.ts"]);
    expect([...(await gitChangedHunks(proj, { base: "HEAD" })).keys()]).toEqual(["match.ts"]);
  });
});
