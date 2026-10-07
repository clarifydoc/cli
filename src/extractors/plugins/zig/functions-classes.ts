import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, Language, PropertyInfo } from "../../functions-classes/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { CONTAINER_TYPES, declValue, isPub } from "./syntax.js";

/**
 * Zig functions and types. `pub fn f(x: T) !R { … }` at file level is a
 * function; a `const Order = struct { … };` (or `enum`/`union`/`opaque`) is a
 * type whose fields are properties and whose `fn`s are methods, nested types
 * included. A file is itself a struct: one that declares fields at the top
 * (`Order.zig` with `id: u64,`) is a type named after the file, and its
 * functions are its methods. `self` is the receiver, not a parameter.
 */
export class ZigExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["zig"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    if (fileIsStruct(node)) return;
    for (const child of node.namedChildren) if (child.type === "function_declaration") functions.push(fn(child));
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    if (fileIsStruct(node)) classes.push(container(FILE_STRUCT, node, node, true));
    const visit = (scope: Node) => {
      for (const child of scope.namedChildren) {
        if (child.type !== "variable_declaration") continue;
        const value = declValue(child);
        const name = child.namedChildren[0]?.type === "identifier" ? child.namedChildren[0].text : null;
        if (!value || !name || !CONTAINER_TYPES.has(value.type)) continue;
        classes.push(container(name, value, child, isPub(child)));
        visit(value);
      }
    };
    visit(node);
  }
}

/**
 * The name the file's own struct is extracted under; the plugin's
 * `postExtract` renames it to the file's stem (`Order.zig` → `Order`), which
 * the extractor cannot see.
 */
export const FILE_STRUCT = "@This()";

/** The file declares fields at its top level — it is a struct type itself. */
function fileIsStruct(root: Node): boolean {
  return root.type === "source_file" && root.namedChildren.some((c) => c.type === "container_field");
}

function container(name: string, body: Node, span: Node, exported: boolean): ClassInfo {
  const cls: ClassInfo = {
    name,
    extends: null,
    implements: [],
    decorators: [],
    methods: body.namedChildren.filter((c) => c.type === "function_declaration").map(fn),
    properties: body.namedChildren.filter((c) => c.type === "container_field").map(field).filter((p): p is PropertyInfo => p !== null),
    isExported: exported,
    line: span.startPosition.row + 1,
    endLine: span.endPosition.row + 1,
  };
  if (body.type === "enum_declaration") cls.kind = "enum";
  return cls;
}

function field(node: Node): PropertyInfo | null {
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  return { name, type: node.childForFieldName("type")?.text ?? null, visibility: "public", isStatic: false, isReadonly: false };
}

function fn(node: Node): FunctionInfo {
  const params = (node.namedChildren.find((c) => c.type === "parameters")?.namedChildren ?? [])
    .filter((p) => p.type === "parameter")
    .map((p) => ({ name: p.childForFieldName("name")?.text ?? "", type: p.childForFieldName("type")?.text ?? null, defaultValue: null }))
    .filter((p) => p.name && p.name !== "self" && p.name !== "_");
  return {
    name: node.childForFieldName("name")?.text ?? "",
    params,
    returnType: node.childForFieldName("type")?.text ?? null,
    isAsync: false,
    isExported: isPub(node),
    decorators: [],
    calls: extractCalls(node.childForFieldName("body"), "zig"),
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}
