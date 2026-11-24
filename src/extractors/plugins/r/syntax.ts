import type { Node } from "web-tree-sitter";

/**
 * Shared readers over the tree-sitter-r tree (@davisvaughan/tree-sitter-r).
 */

const ASSIGN_LEFT = new Set(["<-", "<<-", "="]);
const ASSIGN_RIGHT = new Set(["->", "->>"]);

/** `name <- value` / `name = value` / `value -> name`: the bound name and value, or null. */
export function assignment(node: Node): { name: string; value: Node } | null {
  if (node.type !== "binary_operator") return null;
  const op = node.childForFieldName("operator")?.type;
  const lhs = node.childForFieldName("lhs");
  const rhs = node.childForFieldName("rhs");
  if (!op || !lhs || !rhs) return null;
  if (ASSIGN_LEFT.has(op) && (lhs.type === "identifier" || lhs.type === "string")) return { name: unquote(lhs), value: rhs };
  if (ASSIGN_RIGHT.has(op) && rhs.type === "identifier") return { name: unbacktick(rhs.text), value: lhs };
  return null;
}

function unquote(node: Node): string {
  return node.type === "string" ? stringValue(node) ?? node.text : unbacktick(node.text);
}

/** A backticked name (`` `rank<-` ``, `` `%+%` ``) as it is spelled where it is called: without the backticks. */
export function unbacktick(text: string): string {
  return text.length > 2 && text.startsWith("`") && text.endsWith("`") ? text.slice(1, -1) : text;
}

/**
 * Whether `call` is the target of an assignment — `rank(xs) <- 2`, `rank(xs) = 2`, `2 -> rank(xs)` — which R runs
 * as a call of the replacement function `` `rank<-` ``. A nested target (`names(x)[1] <- v`) is the subset's, not the call's.
 */
export function isReplacementTarget(call: Node): boolean {
  const p = call.parent;
  if (!p || p.type !== "binary_operator") return false;
  const op = p.childForFieldName("operator")?.text;
  if (!op) return false;
  const side = ASSIGN_LEFT.has(op) ? p.childForFieldName("lhs") : ASSIGN_RIGHT.has(op) ? p.childForFieldName("rhs") : null;
  return side !== null && side.id === call.id;
}

/** A string literal's content (`"x"`, `'x'`, `r"(x)"`), or null when `node` is no string. */
export function stringValue(node: Node | null | undefined): string | null {
  if (!node || node.type !== "string") return null;
  return node.childForFieldName("content")?.text ?? "";
}

/**
 * The function a `call` names: `f`, `pkg::f` → `pkg.f`, `obj$method` →
 * `obj.method`, `self$repo$find` → `self.repo.find`. Null for a computed
 * callee (`(function(x) x)(1)`, `fns[[1]]()`).
 */
export function callName(call: Node): string | null {
  const fn = call.childForFieldName("function");
  return fn ? calleeText(fn) : null;
}

function calleeText(node: Node): string | null {
  if (node.type === "identifier") return unbacktick(node.text);
  if (node.type === "namespace_operator" || node.type === "extract_operator") {
    const lhs = node.childForFieldName("lhs");
    const rhs = node.childForFieldName("rhs");
    const left = lhs ? calleeText(lhs) : null;
    if (!left || !rhs || rhs.type !== "identifier") return null;
    return `${left}.${rhs.text}`;
  }
  return null;
}

/** A call's arguments in order: `name = value` or a positional value. */
export function callArgs(call: Node): Array<{ name: string | null; value: Node | null; node: Node }> {
  const args = call.childForFieldName("arguments");
  if (!args) return [];
  return args.namedChildren
    .filter((a) => a.type === "argument")
    .map((a) => ({ name: a.childForFieldName("name")?.text ?? null, value: a.childForFieldName("value"), node: a }));
}

/** The leaf of a call name: `httr.GET` → `GET`. */
export function leafOf(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/**
 * Locals bound to `X$new(…)` (an R6 class or a `setRefClass` generator, `pkg::X$new(…)` too): `p <- Player$new()` types `p`
 * as `Player`, so `p$sign()` resolves on that class and its bases. Whether `X` is a project class is the linker's call.
 * A name assigned two different types in the body stays untyped. `topLevel` reads the statements of a file, not what functions hold.
 */
export function r6Locals(scope: Node, topLevel = false): Array<{ name: string; type: string }> {
  const types = new Map<string, string | null>();
  for (const node of topLevel ? scope.namedChildren : scope.descendantsOfType("binary_operator")) {
    const bound = assignment(node);
    if (!bound || bound.value.type !== "call") continue;
    const callee = callName(bound.value);
    const parts = callee?.split(".");
    if (!parts || parts.length < 2 || parts[parts.length - 1] !== "new") continue;
    const type = parts[parts.length - 2]!;
    types.set(bound.name, types.has(bound.name) && types.get(bound.name) !== type ? null : type);
  }
  return [...types].flatMap(([name, type]) => (type ? [{ name, type }] : []));
}
