import { realpathSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { gitText } from "../core/git-safe.js";

/** Where an impact question reads the working files from, when that is not the analyzed checkout. */
export interface ImpactWorktree {
  /** The directory (the project's folder inside the other checkout) the diff, hunks and re-analysis read. */
  root: string;
  /** Said in the answer. */
  label: string;
}

async function repoFacts(dir: string): Promise<{ top: string; common: string } | null> {
  const [top, common] = await Promise.all([gitText(dir, ["rev-parse", "--show-toplevel"], 10_000), gitText(dir, ["rev-parse", "--git-common-dir"], 10_000)]);
  if (!top?.trim() || !common?.trim()) return null;
  try {
    return { top: realpathSync(top.trim()), common: realpathSync(resolve(dir, common.trim())) };
  } catch {
    return null;
  }
}

/**
 * The other checkout of the analyzed repository a change is being made in — a linked worktree beside the one the
 * server serves. Both must share one git common directory (never another repository), and the project keeps its
 * place inside it, so repo-relative paths mean the same in both. Returns null for the analyzed checkout itself.
 * Throws with the reason when the path is not such a worktree.
 */
export async function resolveImpactWorktree(projectRoot: string, requested: string): Promise<ImpactWorktree | null> {
  const asked = resolve(requested);
  let isDir = false;
  try {
    isDir = statSync(asked).isDirectory();
  } catch {
    /* reported below */
  }
  if (!isDir) throw new Error(`worktree: "${requested}" is not a directory.`);
  const [mine, theirs] = await Promise.all([repoFacts(projectRoot), repoFacts(asked)]);
  if (!mine) throw new Error("worktree: the analyzed project is not in a git repository.");
  if (!theirs) throw new Error(`worktree: "${requested}" is not inside a git repository.`);
  if (theirs.common !== mine.common) throw new Error(`worktree: "${requested}" belongs to another repository than the analyzed project — only a worktree of the same repository is accepted.`);
  if (theirs.top === mine.top) return null;
  let rel = "";
  try {
    rel = relative(mine.top, realpathSync(projectRoot));
  } catch {
    /* project at the top */
  }
  const root = rel ? join(theirs.top, rel) : theirs.top;
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`worktree: ${theirs.top} has no ${rel || "project"} folder.`);
  }
  return { root, label: `worktree ${theirs.top}` };
}

/** The worktree argument, else the server's `CLARIFYDOC_WORKTREE`; empty when neither is set. */
export function requestedWorktree(arg: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return (arg ?? "").trim() || (env.CLARIFYDOC_WORKTREE ?? "").trim();
}
