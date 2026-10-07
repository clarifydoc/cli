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
  if (ASSIGN_RIGHT.has(op) && rhs.type === "identifier") return { name: rhs.text, value: lhs };
  return null;
}

function unquote(node: Node): string {
  return node.type === "string" ? stringValue(node) ?? node.text : node.text;
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
  if (node.type === "identifier") return node.text;
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
