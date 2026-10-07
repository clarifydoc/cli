import type { Node } from "web-tree-sitter";
import type { ParamInfo } from "../../../types/analysis.js";

/** Containers whose definitions belong to the file: the file and its modules. */
export const MODULE_NODES: ReadonlySet<string> = new Set(["source_file", "module_definition", "baremodule_definition"]);

/** The call a definition's signature / short-form left side is: `f(x::Int)::T` → `f(x::Int)`. */
export function signatureCall(node: Node | null | undefined): Node | null {
  if (!node) return null;
  if (node.type === "call_expression") return node;
  if (node.type === "signature" || node.type === "typed_expression" || node.type === "where_expression") return signatureCall(node.namedChildren[0]);
  return null;
}

/** `total(o::Order) = …` — an assignment whose left side is a call: a short-form function. */
export function isShortFunction(node: Node): boolean {
  return node.type === "assignment" && !!signatureCall(node.namedChildren[0]);
}

/** A callee's name: `f`, `Base.show` → `Base.show`, `HTTP.get`. */
export function calleeName(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "field_expression") {
    const left = calleeName(node.childForFieldName("value") ?? node.namedChildren[0]);
    const right = node.namedChildren[node.namedChildren.length - 1];
    return left && right?.type === "identifier" ? `${left}.${right.text}` : null;
  }
  if (node.type === "parametrized_type_expression") return calleeName(node.namedChildren[0]);
  return null;
}

/** Parameters of a signature call: `x`, `x::Int`, `x=1`, `x::Int=1`, keyword args after `;`. */
export function params(call: Node): ParamInfo[] {
  const list = call.namedChildren.find((c) => c.type === "argument_list");
  if (!list) return [];
  const out: ParamInfo[] = [];
  const visit = (n: Node) => {
    if (n.type === "identifier") { out.push({ name: n.text, type: null, defaultValue: null }); return; }
    if (n.type === "typed_expression") {
      const [name, type] = n.namedChildren;
      if (name?.type === "identifier") out.push({ name: name.text, type: type?.text ?? null, defaultValue: null });
      return;
    }
    if (n.type === "named_argument" || n.type === "assignment" || n.type === "optional_parameter") {
      const target = n.namedChildren[0];
      const value = n.namedChildren[n.namedChildren.length - 1];
      const before = out.length;
      if (target) visit(target);
      if (out.length > before && value && value !== target) out[out.length - 1]!.defaultValue = value.text;
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  for (const c of list.namedChildren) visit(c);
  return out;
}

/**
 * A string literal's text (`"x"`, `"""x"""`, `raw"x"`), an interpolation
 * written as its hole: `"…/users/$(id)"` → `…/users/{id}`. Null for no string.
 */
export function stringValue(node: Node | null | undefined): string | null {
  if (!node || !/string_literal$/.test(node.type)) return null;
  if (node.namedChildCount === 0) return node.text.replace(/^\w*("""|")|("""|")$/g, "");
  return node.namedChildren
    .map((c) => (c.type === "content" ? c.text : c.type === "string_interpolation" ? `{${c.descendantsOfType("identifier").pop()?.text ?? ""}}` : ""))
    .join("");
}
