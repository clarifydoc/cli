import type { Node } from "web-tree-sitter";

/** A declaration carries `pub` (or `export`, the C ABI) as an anonymous token. */
export function isPub(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const t = node.child(i)!.type;
    if (t === "pub" || t === "export") return true;
    if (t === "fn" || t === "const" || t === "var") break;
  }
  return false;
}

/**
 * A callee as written: `foo`, `repo.save`, `std.debug.print`. A decl
 * literal (`.init(…)`, `.get("/", h)`) resolves by its result type, which
 * the call does not state — null; so is a chain through a call result.
 */
export function calleeName(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "field_expression") {
    const object = node.childForFieldName("object");
    const member = node.childForFieldName("member")?.text;
    if (!object || !member) return null;
    const head = calleeName(object);
    return head ? `${head}.${member}` : null;
  }
  return null;
}

/** The member a call is made through, object or not: `.get("/x", h)` / `router.get(…)` → `get`. */
export function memberName(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  return node.type === "field_expression" ? node.childForFieldName("member")?.text ?? null : null;
}

/** A call's arguments: its named children after the callee. */
export function callArgs(call: Node): Node[] {
  const fn = call.childForFieldName("function");
  return call.namedChildren.filter((c) => c.id !== fn?.id);
}

/** A string literal's text: `"x"` (escapes as written) or a `\\` multiline string. Null for anything else. */
export function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "string") return node.namedChildren.map((c) => c.text).join("");
  if (node.type === "multiline_string") return node.text.split("\n").map((l) => l.replace(/^\s*\\\\/, "")).join("\n");
  return null;
}

/** `@import("x")` → `x`, or null. */
export function importSource(node: Node | null | undefined): string | null {
  if (node?.type !== "builtin_function") return null;
  if (node.namedChildren[0]?.text !== "@import") return null;
  return stringValue(node.namedChildren.find((c) => c.type === "arguments")?.namedChildren[0]);
}

/** Container declarations that are types: `struct { … }`, `enum { … }`, `union(enum) { … }`, `opaque {}`. */
export const CONTAINER_TYPES = new Set(["struct_declaration", "enum_declaration", "union_declaration", "opaque_declaration"]);

/** The value a `const X = …;` binds (its last named child). */
export function declValue(decl: Node): Node | null {
  const kids = decl.namedChildren;
  return kids.length > 1 ? kids[kids.length - 1]! : null;
}
