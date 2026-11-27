import { execFile } from "child_process";

/**
 * Arguments every git the analyzer spawns carries, so that a repository's own
 * `.git/config` can never make git run a program of its choosing. A folder
 * handed to `analyze` (a downloaded tree with its `.git/`, an untrusted
 * workspace) is data, never code.
 *
 * - `core.fsmonitor` names a command git runs whenever it reads the index
 *   (`status`, `diff HEAD`, `ls-files`) — off for every call.
 * - `diff.external` and a `diff.<driver>.textconv` that `.gitattributes`
 *   selects run on any diff or `log -p` — `GIT_SAFE_DIFF` turns both off.
 * - `core.quotePath`, `diff.noprefix` and `diff.mnemonicPrefix` are pinned (config, so
 *   before the subcommand) and `GIT_SAFE_DIFF` states the prefixes, so a diff reads the same
 *   under every user's config. `GIT_SAFE_DIFF` also pins `--inter-hunk-context=0` and `--diff-algorithm=myers`:
 *   no hunk is widened or moved by the user's `diff.interHunkContext` or `diff.algorithm`.
 */
export const GIT_SAFE_CONFIG: readonly string[] = [
  "-c", "core.fsmonitor=false",
  // The user's own settings must not change what a diff looks like: a non-ASCII name written
  // as `"spill\303\251.ts"`, `i/`/`w/` or no prefix at all.
  "-c", "core.quotePath=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
];

/** Options for a command that renders a diff (`diff`, `log -p`, `show`). */
export const GIT_SAFE_DIFF: readonly string[] = [
  "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/",
  // `diff.interHunkContext` joins two edits into one hunk and so reports the unchanged lines between them as changed.
  "--inter-hunk-context=0",
  // `diff.algorithm` moves hunk edges: on repeated shapes (several functions with one body) myers reports scattered
  // lines of unchanged functions where patience/histogram report one block. Pinned to git's own default, so every
  // user reads the same hunks as a repository without that config.
  "--diff-algorithm=myers",
];

/** `git -C root …args` with the safe config in front. */
export function gitArgs(root: string, args: readonly string[]): string[] {
  return [...GIT_SAFE_CONFIG, "-C", root, ...args];
}

/** A git command's stdout, run safely under a timeout; null when git is missing, fails or times out. */
export function gitText(root: string, args: readonly string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", gitArgs(root, args), { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout.toString()),
    );
  });
}

/**
 * A revision, branch or range that came from a caller (a `--base` flag, an MCP argument, a forge's
 * pull request) read as a ref and never as a git option: a value that starts with `-` is refused
 * (`--output=<file>` would make `git diff` write a file, `--exec=…` and `-p` change what it does),
 * as is one holding a NUL or a line break. `what` names the argument in the error. Every git call
 * that takes such a value passes it through here, and puts `--end-of-options` in front of it
 * where git reads one (`diff`, `rev-parse`, `log`; see {@link gitEndOfOptions}); a test in
 * `git-safe.test.ts` fails on a source file that spawns git without it.
 */
export function assertGitRef(value: string, what = "ref"): string {
  if (value.startsWith("-")) throw new Error(`${what} "${value}" starts with "-": a git ref cannot be an option`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${what} holds a control character: not a git ref`);
  return value;
}

/** Ends the options of a git command: what follows is a revision, never a flag (git 2.24 and later). */
export const GIT_END_OF_OPTIONS = "--end-of-options";

/** `[GIT_END_OF_OPTIONS]` for a `git version` text of 2.24 or later, else `[]`; an unreadable version gives `[]`. */
export function endOfOptionsFor(versionText: string | null): string[] {
  const m = /(\d+)\.(\d+)/.exec(versionText ?? "");
  if (!m) return [];
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 24) ? [GIT_END_OF_OPTIONS] : [];
}

let endOfOptionsProbe: Promise<string[]> | undefined;

/**
 * What goes before a caller's ref: `--end-of-options` when the installed git reads it, nothing on git
 * before 2.24 (the refusal in {@link assertGitRef} alone closes the injection there). One `git version`
 * per process, asked only by the diff, impact and base-ref paths.
 */
export function gitEndOfOptions(): Promise<string[]> {
  endOfOptionsProbe ??= new Promise((resolve) => {
    execFile(process.env.CLARIFYDOC_GIT ?? "git", ["version"], { timeout: 5000, windowsHide: true }, (err, out) =>
      resolve(err ? [] : endOfOptionsFor(out.toString())),
    );
  });
  return endOfOptionsProbe;
}
