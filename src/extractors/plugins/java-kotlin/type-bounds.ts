import type { Node } from "web-tree-sitter";
import { dropLetterBounds } from "../shared/type-parameter-bounds.js";

export { boundedType } from "../shared/type-parameter-bounds.js";

/**
 * The bound of each type parameter in scope of a Java/Kotlin member: `<U extends Boat>` /
 * `fun <U : Boat>` on the method, `class Garage<T extends Car>` on each enclosing class (innermost
 * first, so a method's own letter beats the class's). A parameter or local written as that letter is
 * then typed as its bound, and `u.sail()` links like any typed receiver. An unbounded letter maps to
 * `null` — it shadows an outer bound of the same name and stays untyped. With several bounds
 * (`T extends Car & Comparable<T>`, Kotlin `where T : Boat, T : Foo`) the first one is the type — a project class
 * listed after a library bound is missed. A bound that is another letter of the member (`where T : U`) leaves the
 * letter untyped; the Kotlin extension receiver (`fun <T : Boat> T.dock()`) takes the bound. Not covered (open):
 * fields and constructor properties written as the letter, and a local class or lambda inside a generic method.
 * The letter-to-bound substitution itself is `../shared/type-parameter-bounds.ts`; core is untouched.
 */
export function typeParameterBounds(member: Node): Map<string, string | null> {
  const bounds = new Map<string, string | null>();
  for (let scope: Node | null = member; scope; scope = scope.parent) {
    if (scope !== member && !CLASS_LIKE.has(scope.type)) continue;
    const where = scope.children.find((c) => c.type === "type_constraints");
    for (const list of scope.children.filter((c) => c.type === "type_parameters")) {
      for (const tp of list.namedChildren) {
        if (tp.type !== "type_parameter") continue;
        const name = tp.namedChildren.find((c) => c.type === "type_identifier")?.text;
        if (!name || bounds.has(name)) continue;
        const bound = boundOf(tp) ?? whereBound(where, name);
        bounds.set(name, bound ? bound : null);
      }
    }
  }
  dropLetterBounds(bounds);
  return bounds;
}

const CLASS_LIKE: ReadonlySet<string> = new Set([
  "class_declaration", "interface_declaration", "record_declaration", "object_declaration",
  "enum_declaration", "class_body", "enum_body",
]);

/** Java `extends A & B` (type_bound) / Kotlin `: A` (a user_type child) — the first named bound. */
function boundOf(tp: Node): string | null {
  const bound = tp.namedChildren.find((c) => c.type === "type_bound");
  const first = bound
    ? bound.namedChildren[0]
    : tp.namedChildren.find((c) => c.type === "user_type" || c.type === "nullable_type");
  return first ? headType(first.text) : null;
}

/** Kotlin `where V : Boat, V : Foo`. */
function whereBound(where: Node | undefined, name: string): string | null {
  for (const c of where?.namedChildren ?? []) {
    if (c.type !== "type_constraint" || c.namedChildren[0]?.text !== name) continue;
    const t = c.namedChildren.find((n, i) => i > 0 && (n.type === "user_type" || n.type === "nullable_type"));
    if (t) return headType(t.text);
  }
  return null;
}

/** `Comparable<T>` stays as written; a nullable `Car?` is the class. */
function headType(text: string): string | null {
  const t = text.trim().replace(/\?$/, "");
  return t.length > 0 ? t : null;
}
