import { execFile } from "child_process";
import { GIT_SAFE_DIFF, assertGitRef, gitArgs, gitEndOfOptions } from "./git-safe.js";

/**
 * Changed files via git, project-relative (matching the analysis `files[]`).
 * `-C root` + `--relative` scope the diff to the analyzed directory even when
 * it sits below the repository root. Default mode diffs the WORKING TREE
 * against `base` and appends untracked files; `--staged` diffs the index.
 *
 * Shared by the `impact` CLI command and the MCP server's impact tool.
 */
export async function gitChangedFiles(
  root: string,
  opts: { base?: string; staged?: boolean } = {},
): Promise<{ files: string[]; label: string; added: string[] }> {
  const run = (args: string[]): Promise<string> =>
    new Promise((res, rej) => {
      execFile(
        "git",
        gitArgs(root, args),
        { maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) =>
          err ? rej(new Error((stderr || err.message).trim())) : res(stdout),
      );
    });
  const split = (out: string): string[] =>
    out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (opts.staged) {
    return {
      files: split(await run(["diff", "--name-only", "--relative", ...GIT_SAFE_DIFF, "--cached"])),
      label: "staged",
      added: split(await run(["diff", "--name-only", "--relative", "--diff-filter=A", ...GIT_SAFE_DIFF, "--cached"])),
    };
  }
  const base = assertGitRef(opts.base ?? "HEAD", "--base");
  const eoo = await gitEndOfOptions();
  const tracked = await run(["diff", "--name-only", "--relative", ...GIT_SAFE_DIFF, ...eoo, base]);
  const untracked = await run(["ls-files", "--others", "--exclude-standard"]);
  // Added = what git itself calls new: files the diff against `base` adds (`--diff-filter=A`, e.g. `git add`ed) and
  // untracked files it does not ignore. Not filtered by language: a new README is added too.
  const addedTracked = await run(["diff", "--name-only", "--relative", "--diff-filter=A", ...GIT_SAFE_DIFF, ...eoo, base]);
  return { files: [...split(tracked), ...split(untracked)], label: base, added: [...new Set([...split(addedTracked), ...split(untracked)])] };
}

/** `git config user.name` at a path, or undefined when it is unset or git is missing. */
export async function gitUserName(cwd: string): Promise<string | undefined> {
  return new Promise((res) => {
    execFile(process.env.CLARIFYDOC_GIT ?? "git", gitArgs(cwd, ["config", "user.name"]), { timeout: 5000, windowsHide: true }, (err, out) => {
      const name = (out ?? "").trim();
      res(err || !name ? undefined : name);
    });
  });
}

/**
 * The changed line ranges of the same diff `gitChangedFiles` lists, from
 * `git diff -U0`; an untracked file is wholly new (no ranges, so every
 * function in it counts as changed by the caller's file-level rule).
 */
export async function gitChangedHunks(root: string, opts: { base?: string; staged?: boolean } = {}): Promise<Map<string, Array<[number, number]>>> {
  const { parseUnifiedHunks } = await import("./changed-symbols.js");
  const eoo = await gitEndOfOptions();
  const out = await new Promise<string>((res, rej) => {
    const args = gitArgs(root, ["diff", "-U0", "--no-color", ...GIT_SAFE_DIFF, "--relative", ...(opts.staged ? ["--cached"] : [...eoo, assertGitRef(opts.base ?? "HEAD", "--base")])]);
    execFile("git", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(stdout)));
  });
  return parseUnifiedHunks(out);
}
