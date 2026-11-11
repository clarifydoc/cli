import { gitText as git } from "./git-safe.js";

/** The commit an analysis was made at. */
export interface SourceRevision {
  commit: string;
  /** Null on a detached HEAD. */
  branch: string | null;
  /** Tracked files with uncommitted changes when the analysis ran. */
  dirty: number;
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

/**
 * Which of `paths` (project-relative) git does not track — new files, scratch copies — not ignored ones.
 * Null without git or outside a work tree, so a caller can say nothing rather than call everything untracked.
 */
export async function untrackedAmong(projectRoot: string, paths: readonly string[]): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set();
  const out = await git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], 5000);
  return out === null ? null : new Set(out.split("\0").filter(Boolean));
}

/** How HEAD stands to the commit an analysis was made at. */
export type CommitRelation =
  | { state: "current" }
  | { state: "behind"; behind: number }
  | { state: "diverged"; ahead: number; behind: number }
  /** HEAD is an ancestor of the analyzed commit (checked out older, or reset). */
  | { state: "older"; ahead: number }
  /** The analyzed commit is not in this repository (rebased away, another clone). */
  | { state: "missing" };

/**
 * Compares the analyzed commit with HEAD using one bounded
 * `rev-list --left-right --count`. Null without git, outside a work tree or
 * when HEAD cannot be read — a caller then says nothing.
 */
export async function commitRelation(projectRoot: string, analyzed: string): Promise<CommitRelation | null> {
  if (!/^[0-9a-f]{7,64}$/.test(analyzed)) return null;
  const head = await headCommit(projectRoot);
  if (!head) return null;
  if (head === analyzed) return { state: "current" };
  const out = await git(projectRoot, ["rev-list", "--left-right", "--count", `${analyzed}...${head}`], 3000);
  const m = out?.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) {
    // A timeout or failure says nothing about the commit; only a commit this repository lacks is "missing".
    const kind = (await git(projectRoot, ["cat-file", "-t", analyzed], 2000))?.trim();
    return kind === "commit" ? null : { state: "missing" };
  }
  const ahead = Number(m[1]); // reachable from the analyzed commit only
  const behind = Number(m[2]); // reachable from HEAD only
  if (ahead === 0 && behind === 0) return { state: "current" };
  if (ahead === 0) return { state: "behind", behind };
  if (behind === 0) return { state: "older", ahead };
  return { state: "diverged", ahead, behind };
}

/** One readable clause for a relation, or null when the analysis is at HEAD. */
export function describeCommitRelation(r: CommitRelation): string | null {
  const n = (k: number) => `${k} commit${k === 1 ? "" : "s"}`;
  switch (r.state) {
    case "current": return null;
    case "behind": return `HEAD is ${n(r.behind)} ahead of the analyzed commit`;
    case "older": return `HEAD is ${n(r.ahead)} older than the analyzed commit`;
    case "diverged": return `HEAD diverged from the analyzed commit (${r.ahead} ahead, ${r.behind} behind)`;
    case "missing": return "the analyzed commit is not in this repository (rebased away?)";
  }
}
