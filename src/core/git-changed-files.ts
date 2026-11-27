import { execFile } from "child_process";
import { GIT_SAFE_DIFF, assertGitRef, gitArgs, gitEndOfOptions } from "./git-safe.js";
import { insideRoot } from "./inside-root.js";

/** A file git reads as moved: `from` is gone (its importers now import nothing), `to` is new. */
export interface RenamedFile {
  from: string;
  to: string;
  /** Git's similarity score, 0-100 (100 = identical content). */
  similarity: number;
}

/**
 * Reads `git diff --name-status -z` output strictly: NUL-separated tokens, a status then one path (two for a
 * rename). A path that is absolute or leaves the root (`insideRoot`) is dropped, a row it breaks with it.
 */
export function parseNameStatusZ(out: string, root: string): { files: string[]; added: string[]; renamed: RenamedFile[] } {
  const tokens = out.split("\0");
  const files: string[] = [];
  const added: string[] = [];
  const renamed: RenamedFile[] = [];
  const ok = (p: string | undefined): p is string => !!p && insideRoot(root, p) !== null;
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]!;
    if (!status) continue;
    const kind = status[0]!;
    if (kind === "R" || kind === "C") {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      i += 2;
      if (kind === "C") {
        // A copy leaves the source in place: only the new path is a change.
        if (ok(to)) { files.push(to); added.push(to); }
      } else if (ok(from) && ok(to)) {
        files.push(from, to);
        added.push(to);
        renamed.push({ from, to, similarity: Number(status.slice(1)) || 0 });
      } else {
        // One end refused: the other still counts as the plain change it is.
        if (ok(from)) files.push(from);
        if (ok(to)) { files.push(to); added.push(to); }
      }
      continue;
    }
    const path = tokens[++i];
    if (!ok(path)) continue;
    files.push(path);
    if (kind === "A") added.push(path);
  }
  return { files, added, renamed };
}

/**
 * Changed files via git, project-relative (matching the analysis `files[]`).
 * `-C root` + `--relative` scope the diff to the analyzed directory even when
 * it sits below the repository root. Default mode diffs the WORKING TREE
 * against `base` and appends untracked files; `--staged` diffs the index.
 *
 * Renames are read from `--name-status -z --find-renames` (pinned, so the user's `diff.renames` never
 * decides): a moved file lists both its old path (`files`, so its importers are charged as for a deletion) and
 * its new one (`files` and `added`), and is stated once in `renamed`. When git skipped exhaustive rename
 * detection (`diff.renameLimit`) `notes` says the list is incomplete; that never fails the call.
 *
 * Shared by the `impact` CLI command and the MCP server's impact tool.
 */
export async function gitChangedFiles(
  root: string,
  opts: { base?: string; staged?: boolean } = {},
): Promise<{ files: string[]; label: string; added: string[]; renamed: RenamedFile[]; notes: string[] }> {
  const run = (args: string[]): Promise<{ out: string; err: string }> =>
    new Promise((res, rej) => {
      execFile(
        "git",
        gitArgs(root, args),
        { maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) =>
          err ? rej(new Error((stderr || err.message).trim())) : res({ out: stdout, err: String(stderr) }),
      );
    });
  const split = (out: string): string[] =>
    out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const label = opts.staged ? "staged" : assertGitRef(opts.base ?? "HEAD", "--base");
  const eoo = opts.staged ? [] : await gitEndOfOptions();
  const diff = await run(["diff", "--name-status", "-z", "--find-renames", "--relative", ...GIT_SAFE_DIFF, ...(opts.staged ? ["--cached"] : [...eoo, label])]);
  const { files, added, renamed } = parseNameStatusZ(diff.out, root);
  const notes = /rename/i.test(diff.err) ? ["git skipped exhaustive rename detection (diff.renameLimit): a moved file may be listed as a deletion and an addition, and the rename list is incomplete"] : [];
  if (opts.staged) return { files, label, added, renamed, notes };
  const untracked = split((await run(["ls-files", "--others", "--exclude-standard"])).out);
  // Added = what git itself calls new: files the diff against `base` adds (e.g. `git add`ed, or the new end of a
  // rename) and untracked files it does not ignore. Not filtered by language: a new README is added too.
  return { files: [...files, ...untracked], label, added: [...new Set([...added, ...untracked])], renamed, notes };
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
 * `git diff -U0 --no-renames` (a moved file reads as its old path removed and its new one added, as
 * `gitChangedFiles` charges it); an untracked file is wholly new (no ranges, so every
 * function in it counts as changed by the caller's file-level rule).
 */
export async function gitChangedHunks(root: string, opts: { base?: string; staged?: boolean } = {}): Promise<import("./changed-symbols.js").ChangedHunks> {
  const { parseUnifiedHunks } = await import("./changed-symbols.js");
  const eoo = await gitEndOfOptions();
  const out = await new Promise<string>((res, rej) => {
    const args = gitArgs(root, ["diff", "-U0", "--no-color", "--no-renames", ...GIT_SAFE_DIFF, "--relative", ...(opts.staged ? ["--cached"] : [...eoo, assertGitRef(opts.base ?? "HEAD", "--base")])]);
    execFile("git", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(stdout)));
  });
  return parseUnifiedHunks(out);
}
