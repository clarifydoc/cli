import { execFile } from "child_process";

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
): Promise<{ files: string[]; label: string }> {
  const run = (args: string[]): Promise<string> =>
    new Promise((res, rej) => {
      execFile(
        "git",
        ["-C", root, ...args],
        { maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) =>
          err ? rej(new Error((stderr || err.message).trim())) : res(stdout),
      );
    });
  const split = (out: string): string[] =>
    out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (opts.staged) {
    return {
      files: split(await run(["diff", "--name-only", "--relative", "--cached"])),
      label: "staged",
    };
  }
  const base = opts.base ?? "HEAD";
  const tracked = await run(["diff", "--name-only", "--relative", base]);
  const untracked = await run(["ls-files", "--others", "--exclude-standard"]);
  return { files: [...split(tracked), ...split(untracked)], label: base };
}
