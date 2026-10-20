import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readSourceRevision, listGitFiles } from "./source-revision.js";
import { runFingerprint } from "./run-fingerprint.js";
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
