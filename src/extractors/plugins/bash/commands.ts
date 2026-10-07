import type { Node } from "web-tree-sitter";

/**
 * Shell builtins and keywords: they run as commands but call nothing the
 * project defines (`set -e`, `echo`, `cd`, `return 1`, `[ -z "$x" ]`). The
 * tools a script drives (`curl`, `psql`, `docker`, `kubectl`) stay calls.
 */
export const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  ".", ":", "[", "[[", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen", "complete",
  "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit", "export", "false", "fc", "fg",
  "getopts", "hash", "help", "history", "jobs", "kill", "let", "local", "logout", "mapfile", "popd", "printf",
  "pushd", "pwd", "read", "readarray", "readonly", "return", "set", "shift", "shopt", "source", "test", "times",
  "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait",
]);

/** Commands that run the command named by their first operand (`sudo docker …`, `env X=1 make`). */
const WRAPPERS: ReadonlySet<string> = new Set(["sudo", "env", "nohup", "time", "exec", "command", "xargs", "nice", "timeout", "stdbuf"]);

/** The operands of a `command` node: every argument after its name (words, strings, expansions). */
export function commandArgs(node: Node): Node[] {
  const name = node.childForFieldName("name");
  return node.namedChildren.filter((c) => c.id !== name?.id && c.type !== "variable_assignment" && c.type !== "file_redirect" && c.type !== "herestring_redirect");
}

/** A word or string operand as the shell would pass it, quotes removed (expansions kept as written). */
export function operandText(node: Node): string {
  const t = node.text;
  if ((node.type === "string" || node.type === "raw_string") && t.length >= 2) return t.slice(1, -1);
  return t;
}

/**
 * The program a `command` node runs: its name, or — behind a wrapper
 * (`sudo`, `env X=1`, `timeout 5`) — the first operand that is no flag,
 * assignment or number. Null for a name the shell computes (`"$cmd" …`).
 */
export function commandName(node: Node): string | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  let name = nameNode.text;
  if (WRAPPERS.has(name)) {
    const next = commandArgs(node).find((a) => !/^-|^\w+=|^\d+[smhd]?$/.test(a.text));
    if (!next) return null;
    name = next.text;
  }
  return /^[A-Za-z_][\w.+-]*$|^[.~]?\/|^[\w.-]+\//.test(name) && !name.startsWith("$") ? name : null;
}
