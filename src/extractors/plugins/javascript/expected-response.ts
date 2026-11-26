import type { Node } from "web-tree-sitter";
import type { BodyStyle } from "./response-reads.js";

/**
 * Required top-level fields of the response type a call states — the type
 * argument of `axios.get<ClubDto>(…)` / similar helpers, or a typed local
 * bound to the body (`const body: ClubDto = await res.json()`). Only closed
 * required members: `Partial`/`DeepPartial` and optional properties
 * (`badge?`) require nothing; an index signature opens the type and yields
 * nothing. Same-file interfaces and type aliases only — never every type in
 * the file.
 */

const PARTIAL = new Set(["Partial", "DeepPartial"]);
const UNWRAP = new Set(["Readonly", "Required", "NonNullable", "Awaited", "Promise"]);

/** The declarator whose value is `node`, possibly awaited or parenthesized. */
function declaratorOf(node: Node): Node | null {
  let n: Node | null = node.parent;
  while (n && (n.type === "await_expression" || n.type === "parenthesized_expression")) n = n.parent;
  return n?.type === "variable_declarator" ? n : null;
}

/** The type node of a declarator's annotation (`: ClubDto` → `ClubDto`). */
function annotatedType(decl: Node): Node | null {
  const ann = decl.childForFieldName("type") ?? decl.namedChildren.find((c) => c.type === "type_annotation") ?? null;
  if (!ann) return null;
  if (ann.type === "type_annotation") return ann.namedChild(0) ?? null;
  return ann;
}

/** First type argument of a call (`get<ClubDto>`), including awaited generics. */
function typeArgOf(call: Node): Node | null {
  const ta = call.childForFieldName("type_arguments") ?? call.namedChildren.find((c) => c.type === "type_arguments");
  return ta?.namedChild(0) ?? null;
}

/** Whether a property signature is optional (`badge?`). */
function isOptionalProp(member: Node): boolean {
  return member.children.some((c) => c.type === "?");
}

/**
 * Required property names of an object/interface body. An index signature
 * means the shape is open — nothing is required of the response.
 */
function requiredOfBody(body: Node | null): string[] | undefined {
  if (!body) return undefined;
  if (body.namedChildren.some((c) => c.type === "index_signature")) return undefined;
  const out: string[] = [];
  for (const m of body.namedChildren) {
    if (m.type !== "property_signature") continue;
    if (isOptionalProp(m)) continue;
    const name = m.childForFieldName("name")?.text;
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
  }
  return out;
}

/** Resolve a type node to required closed member names in `root`'s file. */
function requiredOfType(type: Node, root: Node, depth = 0): string[] | undefined {
  if (depth > 4) return undefined;
  if (type.type === "object_type" || type.type === "interface_body") return requiredOfBody(type);
  if (type.type === "generic_type") {
    const name = type.childForFieldName("name")?.text ?? type.namedChild(0)?.text;
    const args = type.childForFieldName("type_arguments") ?? type.namedChildren.find((c) => c.type === "type_arguments");
    const inner = args?.namedChild(0) ?? null;
    if (!name || !inner) return undefined;
    if (PARTIAL.has(name)) return undefined;
    if (UNWRAP.has(name)) return requiredOfType(inner, root, depth + 1);
    // Array / Record / Map: not a closed object of named members.
    return undefined;
  }
  if (type.type === "type_identifier" || type.type === "nested_type_identifier") {
    const want = type.type === "nested_type_identifier" ? (type.text.split(".").pop() ?? type.text) : type.text;
    for (const d of root.descendantsOfType(["interface_declaration", "type_alias_declaration"])) {
      if (d.childForFieldName("name")?.text !== want) continue;
      if (d.type === "interface_declaration") return requiredOfBody(d.childForFieldName("body"));
      const value = d.childForFieldName("value");
      return value ? requiredOfType(value, root, depth + 1) : undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * For fetch-style calls: the type of `const body: ClubDto = await res.json()`,
 * where `res` is the binding of this call.
 */
function jsonResultType(call: Node): Node | null {
  const decl = declaratorOf(call);
  if (!decl) return null;
  const bound = decl.childForFieldName("name");
  if (bound?.type !== "identifier") return null;
  let block: Node | null = decl.parent;
  while (block && block.type !== "statement_block" && block.type !== "program") block = block.parent;
  if (!block) return null;
  const name = bound.text;
  for (const d of block.descendantsOfType("variable_declarator")) {
    if (d.startIndex < decl.endIndex) continue;
    const value = d.childForFieldName("value");
    let v: Node | null = value;
    while (v && (v.type === "await_expression" || v.type === "parenthesized_expression")) v = v.namedChild(0);
    if (v?.type !== "call_expression") continue;
    const fn = v.childForFieldName("function");
    if (fn?.type !== "member_expression") continue;
    if (fn.childForFieldName("object")?.text !== name) continue;
    if (fn.childForFieldName("property")?.text !== "json") continue;
    const typed = annotatedType(d);
    if (typed) return typed;
  }
  // Direct body: `const body: ClubDto = await fetch(…)` (no .json()).
  return annotatedType(decl);
}

/**
 * The response type attached to this call: its type argument, else the type
 * of the local that binds the body (fetch `json()` / a direct body).
 */
function expectedTypeOf(call: Node, style: BodyStyle): Node | null {
  const fromArg = typeArgOf(call);
  if (fromArg) return fromArg;
  if (style === "json") return jsonResultType(call);
  if (style === "direct") {
    const decl = declaratorOf(call);
    return decl ? annotatedType(decl) : null;
  }
  // axios-style: the type usually sits on the call (`get<T>`); a typed local
  // of `.data` is uncommon and left for a later pass.
  return null;
}

/**
 * Required closed members of the call's expected response type, sorted.
 *
 * An api-call states `expectedResponseFields` when its call or typed body binding names a closed response type
 * (`axios.get<ClubDto>`, `const body: ClubDto = await res.json()`): required same-file interface / type-alias members
 * only; `Partial` / optional properties and index signatures require nothing.
 */
export function expectedResponseFieldsOf(call: Node, style: BodyStyle): string[] | undefined {
  let root: Node | null = call;
  while (root?.parent) root = root.parent;
  if (!root) return undefined;
  const type = expectedTypeOf(call, style);
  if (!type) return undefined;
  const fields = requiredOfType(type, root);
  if (!fields || fields.length === 0) return undefined;
  return [...new Set(fields)].sort();
}
