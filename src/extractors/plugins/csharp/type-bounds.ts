import type { Node } from "web-tree-sitter";
import { dropLetterBounds } from "../shared/type-parameter-bounds.js";

export { boundedType } from "../shared/type-parameter-bounds.js";

/**
 * The constraint of each type parameter in scope of a C# member: `where U : Boat` on the method, a
 * class's `where T : Car` on each enclosing type (innermost first, so a method's own letter beats the
 * class's). A parameter or local written as that letter is typed as its constraint, so `u.Sail()` links
 * like any typed receiver. A letter with no type constraint maps to `null`: it shadows an outer bound
 * and stays untyped. Several constraints (`where T : class, Boat, new()`) use the first one that names a
 * type — `class`, `struct`, `notnull`, `unmanaged`, `new()` and `default` name none.
 */
export function typeParameterBounds(member: Node): Map<string, string | null> {
  const bounds = new Map<string, string | null>();
  for (let scope: Node | null = member; scope; scope = scope.parent) {
    if (scope !== member && !TYPE_DECLARATIONS.has(scope.type)) continue;
    const list = scope.children.find((c) => c.type === "type_parameter_list");
    if (!list) continue;
    for (const tp of list.namedChildren) {
      if (tp.type !== "type_parameter") continue;
      const name = tp.namedChildren.find((c) => c.type === "identifier")?.text;
      if (!name || bounds.has(name)) continue;
      bounds.set(name, constraintOf(scope, name));
    }
  }
  dropLetterBounds(bounds);
  return bounds;
}

const TYPE_DECLARATIONS: ReadonlySet<string> = new Set([
  "class_declaration", "struct_declaration", "interface_declaration", "record_declaration", "record_struct_declaration",
]);

const NO_TYPE: ReadonlySet<string> = new Set(["class", "struct", "notnull", "unmanaged", "default"]);

function constraintOf(scope: Node, name: string): string | null {
  for (const clause of scope.children) {
    if (clause.type !== "type_parameter_constraints_clause") continue;
    if (clause.namedChildren.find((c) => c.type === "identifier")?.text !== name) continue;
    for (const c of clause.namedChildren) {
      if (c.type !== "type_parameter_constraint") continue;
      const inner = c.namedChildren[0];
      if (!inner || inner.type === "constructor_constraint" || NO_TYPE.has(inner.type) || NO_TYPE.has(inner.text)) continue;
      return inner.text;
    }
  }
  return null;
}
