import { execFile } from "child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, join, relative, resolve } from "path";
import { gitArgs } from "./git-safe.js";
import { analyze } from "./analyzer.js";

/**
 * The analysis of a project at another commit — the base of a change — for
 * `diff --base <ref>`: the commit checked out in a temporary detached
 * worktree, analyzed, and the worktree removed. The analysis is kept under
 * the head's analysis directory, `.base/<commit>/`, so a second diff against
 * the same base reuses it; seeded from the head's analysis when there is one,
 * so only the files that differ reparse. Nothing in the working tree, the
 * index or the branches is touched.
 */

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) =>
    execFile("git", gitArgs(cwd, args), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) =>
      err ? fail(new Error(stderr.trim() || err.message)) : ok(stdout.trim()),
    ),
  );
}

export async function analysisAtRef(
  projectRoot: string,
  ref: string,
  opts: { headAnalysisDir?: string; cacheBase: string; log?: (line: string) => void },
): Promise<{ dir: string; commit: string; reused: boolean }> {
  const root = resolve(projectRoot);
  const repo = await git(root, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error(`${root} is not in a git repository: --base needs one`);
  });
  const commit = await git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).catch(() => {
    throw new Error(`No commit "${ref}" in ${repo}`);
  });
  const name = basename(root);
  const dir = join(resolve(opts.cacheBase), commit, name);
  if (existsSync(join(dir, "project-summary.json"))) return { dir, commit, reused: true };

  // The worktree's folders carry the repository's and the project's names: the analysis is filed under them.
  const scratch = await mkdtemp(join(tmpdir(), "clarifydoc-base-"));
  const wt = join(scratch, basename(repo));
  // Git answers with the real path (`/private/var/…` for `/var/…`): compare like with like.
  const rel = relative(realpathSync(repo), realpathSync(root));
  if (rel.startsWith("..")) throw new Error(`${root} is not inside ${repo}`);
  try {
    await git(repo, ["worktree", "add", "--detach", "--force", wt, commit]);
    const baseRoot = rel ? join(wt, rel) : wt;
    if (!existsSync(baseRoot)) throw new Error(`${rel || "the project"} does not exist at ${ref} (${commit.slice(0, 12)})`);
    if (opts.headAnalysisDir && existsSync(join(opts.headAnalysisDir, "manifest.json"))) {
      // Entry by entry, leaving out the cached bases themselves, which may sit inside it.
      const cache = resolve(opts.cacheBase);
      await mkdir(dir, { recursive: true });
      for (const entry of await readdir(opts.headAnalysisDir)) {
        const from = join(opts.headAnalysisDir, entry);
        if (resolve(from) === cache) continue;
        await cp(from, join(dir, entry), { recursive: true });
      }
    }
    opts.log?.(`analyzing ${ref} (${commit.slice(0, 12)}) in a temporary worktree`);
    await analyze({ projectRoot: baseRoot, outputDir: dir, incremental: true, lsp: false, gitHistory: false });
    return { dir, commit, reused: false };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  } finally {
    await git(repo, ["worktree", "remove", "--force", wt]).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]).catch(() => undefined);
  }
}
