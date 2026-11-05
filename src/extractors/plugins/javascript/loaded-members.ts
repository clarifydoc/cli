import type { Node } from "web-tree-sitter";
import { requiredSource } from "./imports-exports.js";

/** `(await import("./x"))`, `await import("./x")`, `import("./x")` and `require("./x")` -> the module path; else null. */
function loadedSource(node: Node): string | null {
  let n: Node | null = node;
  while (n && (n.type === "parenthesized_expression" || n.type === "await_expression")) n = n.namedChildren[0] ?? null;
  if (!n || n.type !== "call_expression") return null;
  if (n.childForFieldName("function")?.type === "import") {
    const arg = n.childForFieldName("arguments")?.namedChildren[0];
    return arg?.type === "string" ? arg.text.slice(1, -1) : null;
  }
  return requiredSource(n);
}

/**
 * A call straight on a module loaded in place: `(await import("./rules")).promote()`,
 * `import("./rules").then(…)` aside, `require("./rules").promote()` — the member the module declares and
 * the path it comes from. Null for any other call.
 */
export function loadedMemberCall(call: Node): { source: string; name: string } | null {
  if (call.type !== "call_expression") return null;
  const callee = call.childForFieldName("function");
  if (callee?.type !== "member_expression") return null;
  const object = callee.childForFieldName("object");
  const property = callee.childForFieldName("property");
  const source = object ? loadedSource(object) : null;
  // `import(…).then(…)` is the promise, not a member of the module.
  if (!source || property?.type !== "property_identifier" || (object!.type === "call_expression" && object!.childForFieldName("function")?.type === "import" && property.text === "then")) return null;
  return { source, name: property.text };
}

/**
 * The path of an `import("./x")` whose module is used for its default export: the body or returned value of a
 * function (a lazy loader, `() => import("./ClubPage.vue")`), or read as `(await import("./x")).default`. Null for
 * a destructured, `.then`-bound or member-called import, and for a non-literal path.
 */
export function loadedDefaultSource(importCall: Node): string | null {
  const arg = importCall.childForFieldName("arguments")?.namedChildren[0];
  if (arg?.type !== "string") return null;
  let up: Node | null = importCall.parent;
  while (up && (up.type === "parenthesized_expression" || up.type === "await_expression")) up = up.parent;
  if (!up) return null;
  const isDefaultRead = up.type === "member_expression" && up.childForFieldName("property")?.text === "default";
  const isLoaderBody = up.type === "arrow_function" || up.type === "return_statement";
  return isDefaultRead || isLoaderBody ? arg.text.slice(1, -1) : null;
}
