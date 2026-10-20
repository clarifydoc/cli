import { execFile } from "child_process";
import { gitArgs } from "./git-safe.js";

/** The commit an analysis was made at. */
export interface SourceRevision {
  commit: string;
  /** Null on a detached HEAD. */
  branch: string | null;
  /** Tracked files with uncommitted changes when the analysis ran. */
  dirty: number;
}

function git(cwd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", gitArgs(cwd, args), { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout.toString()),
    );
  });
}

/** The commit, branch and dirty count of a git work tree; null outside one or without git. */
export async function readSourceRevision(projectRoot: string): Promise<SourceRevision | null> {
  const commit = (await git(projectRoot, ["rev-parse", "HEAD"]))?.trim();
  if (!commit || !/^[0-9a-f]{7,64}$/.test(commit)) return null;
  const branch = (await git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? null;
  const status = await git(projectRoot, ["status", "--porcelain", "--untracked-files=no"]);
  return { commit, branch: branch && branch !== "HEAD" ? branch : null, dirty: status ? status.split("\n").filter(Boolean).length : 0 };
}

/** The current HEAD, or null. */
export async function headCommit(projectRoot: string): Promise<string | null> {
  const c = (await git(projectRoot, ["rev-parse", "HEAD"]))?.trim();
  return c && /^[0-9a-f]{7,64}$/.test(c) ? c : null;
}

/** Files git tracks or would track (untracked, not ignored), relative to the project root, posix. Null without git. */
export async function listGitFiles(projectRoot: string): Promise<string[] | null> {
  const out = await git(projectRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], 10_000);
  return out === null ? null : out.split("\0").filter(Boolean);
}
