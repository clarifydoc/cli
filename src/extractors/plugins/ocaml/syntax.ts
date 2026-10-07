import type { Node } from "web-tree-sitter";

/** A value reference as written: `find`, `Db.find`, `Dream.get` (an empty module path is dropped). */
export function valuePath(node: Node | null | undefined): string | null {
  if (!node || node.type !== "value_path") return null;
  return node.text.replace(/\s+/g, "") || null;
}

/** A string's text: `"…"` or a quoted string `{sql| … |sql}`. Null for anything else. */
export function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "string") return node.namedChildren.filter((c) => c.type === "string_content").map((c) => c.text).join("");
  if (node.type === "quoted_string") return node.namedChildren.find((c) => c.type === "quoted_string_content")?.text ?? "";
  if (node.type === "parenthesized_expression") return stringValue(node.namedChildren[0]);
  return null;
}

/** An application's positional arguments (labeled ones — `~body:x` — left out). */
export function positionalArgs(app: Node): Node[] {
  const fn = app.childForFieldName("function");
  return app.namedChildren.filter((c) => c.id !== fn?.id && c.type !== "labeled_argument");
}

/** `~url:"…"` → the labeled argument's value. */
export function labeledArg(app: Node, label: string): Node | null {
  for (const c of app.namedChildren) {
    if (c.type === "labeled_argument" && c.namedChildren[0]?.text === label) return c.namedChildren[1] ?? null;
  }
  return null;
}

/** A `let` that defines a function: it takes parameters, or binds `fun`/`function`. */
export function isFunctionBinding(binding: Node): boolean {
  if (binding.type !== "let_binding" || binding.childForFieldName("pattern")?.type !== "value_name") return false;
  if (binding.namedChildren.some((c) => c.type === "parameter")) return true;
  const body = binding.childForFieldName("body");
  return body?.type === "fun_expression" || body?.type === "function_expression";
}
