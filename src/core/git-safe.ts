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
 */
export const GIT_SAFE_CONFIG: readonly string[] = ["-c", "core.fsmonitor=false"];

/** Options for a command that renders a diff (`diff`, `log -p`, `show`). */
export const GIT_SAFE_DIFF: readonly string[] = ["--no-ext-diff", "--no-textconv"];

/** `git -C root …args` with the safe config in front. */
export function gitArgs(root: string, args: readonly string[]): string[] {
  return [...GIT_SAFE_CONFIG, "-C", root, ...args];
}
