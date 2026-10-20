import type { Node } from "web-tree-sitter";
import type { JsonSchemaNode } from "../../../types/analysis.js";

/**
 * The body a `PostAsJsonAsync` / `PutAsJsonAsync` / `PatchAsJsonAsync` call
 * sends, as far as the call site states it: an anonymous object
 * (`new { Name = n, Age = 3 }`), an object initializer (`new CreateUser { Name
 * = n }`), or a local holding one. The JSON helpers serialize with the web
 * defaults, so `Name` goes over the wire as `name`. Values are typed by their
 * literal; anything else is an empty schema. Null when the body is not stated.
 */
export function csharpJsonBody(call: Node): JsonSchemaNode | null {
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type === "argument");
  let value: Node | null = args[1]?.namedChildren[0] ?? null;
  if (value?.type === "identifier") value = localValue(value);
  return value ? objectSchema(value, 0) : null;
}

const camel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

function objectSchema(n: Node, depth: number): JsonSchemaNode | null {
  if (n.type === "anonymous_object_creation_expression") {
    const properties: Record<string, JsonSchemaNode> = {};
    // Members are flat: `Name = expr` or a projection `expr` (`email`, `user.Email`), comma-separated.
    let group: Node[] = [];
    const flush = () => {
      if (!group.length) return;
      const eq = group.findIndex((c) => c.type === "=");
      if (eq === 1 && group[0]!.type === "identifier") properties[camel(group[0]!.text)] = valueSchema(group[2] ?? null, depth);
      else {
        const last = /(\w+)\s*$/.exec(group[group.length - 1]!.text)?.[1];
        if (last && group.length === 1) properties[camel(last)] = valueSchema(group[0]!, depth);
      }
      group = [];
    };
    for (const c of n.children) {
      if (c.type === "new" || c.type === "{" || c.type === "}") continue;
      if (c.type === ",") flush();
      else group.push(c);
    }
    flush();
    return { type: "object", properties };
  }
  if (n.type === "object_creation_expression") {
    const init = n.childForFieldName("initializer");
    if (!init) return null;
    const properties: Record<string, JsonSchemaNode> = {};
    for (const a of init.namedChildren) {
      if (a.type !== "assignment_expression") continue;
      const left = a.childForFieldName("left");
      if (left?.type === "identifier") properties[camel(left.text)] = valueSchema(a.childForFieldName("right"), depth);
    }
    return { type: "object", properties };
  }
  return null;
}

function valueSchema(v: Node | null, depth: number): JsonSchemaNode {
  if (!v || depth > 4) return {};
  switch (v.type) {
    case "string_literal": case "verbatim_string_literal": case "raw_string_literal": case "interpolated_string_expression": return { type: "string" };
    case "integer_literal": return { type: "integer" };
    case "real_literal": return { type: "number" };
    case "boolean_literal": return { type: "boolean" };
    case "null_literal": return { nullable: true };
    case "implicit_array_creation_expression": case "array_creation_expression": {
      const first = v.childForFieldName("initializer")?.namedChildren[0] ?? v.namedChildren.find((c) => c.type === "initializer_expression")?.namedChildren[0];
      return { type: "array", ...(first ? { items: valueSchema(first, depth + 1) } : {}) };
    }
    case "anonymous_object_creation_expression": case "object_creation_expression": return objectSchema(v, depth + 1) ?? {};
    default: return {};
  }
}

/** The initializer of the local a name was declared with earlier in the same method. */
function localValue(name: Node): Node | null {
  let scope: Node | null = name.parent;
  while (scope && !/^(?:method|constructor|local_function)_declaration$|^lambda_expression$/.test(scope.type)) scope = scope.parent;
  if (!scope) return null;
  let found: Node | null = null;
  const visit = (n: Node): void => {
    if (n.startIndex >= name.startIndex) return;
    if (n.type === "variable_declarator" && n.childForFieldName("name")?.text === name.text) {
      found = n.namedChildren.find((c) => c.type !== "identifier" && c !== n.childForFieldName("name")) ?? null;
      if (found?.type === "equals_value_clause") found = found.namedChildren[0] ?? null;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(scope);
  return found;
}
