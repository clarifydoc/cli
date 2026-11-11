import type { Node } from "web-tree-sitter";

/**
 * A Java anonymous class (`new Base() { … }`): the `object_creation_expression` that carries a `class_body`.
 * Its methods are no symbols of the enclosing class, and the walk attributes their calls to the method that
 * builds the object; what it adds is the type it is, so a bare call inside resolves on `Base`
 * (`CallInfo.withSubjects`) and `handler.run()` on a local initialized by it reaches its `run`.
 */
export function isAnonymousClassCreation(node: Node): boolean {
  return node.type === "object_creation_expression" && node.children.some((c) => c.type === "class_body");
}

/** The type an anonymous class extends or implements, as written without type arguments (`Base`, `league.Base`). */
export function anonymousBaseOf(creation: Node): string | null {
  const type = creation.childForFieldName("type");
  const text = type?.text.replace(/<[\s\S]*$/, "").replace(/\s+/g, "");
  return text && /^[\w.]+$/.test(text) ? text : null;
}

/** The name the anonymous class has in its file: `Base$12_20`, the leaf of its base and where it is written (line, column). */
export function anonymousClassName(creation: Node): string | null {
  const base = anonymousBaseOf(creation);
  return base ? `${base.split(".").pop()}$${creation.startPosition.row + 1}_${creation.startPosition.column}` : null;
}

/**
 * The anonymous bases a bare call sits inside, innermost first, up to the method that holds it. A call on
 * `this`, a receiver or a constructor is no bare call, and a call in a named member class of the anonymous body stops the
 * climb (that class is its own scope).
 */
export function anonymousSubjectsOf(call: Node): string[] | null {
  if (call.type !== "method_invocation" || call.childForFieldName("object")) return null;
  const out: string[] = [];
  for (let p: Node | null = call.parent; p; p = p.parent) {
    if (p.type === "class_declaration" || p.type === "interface_declaration" || p.type === "enum_declaration" || p.type === "record_declaration") break;
    if (p.type === "class_body" && p.parent && isAnonymousClassCreation(p.parent)) {
      const base = anonymousBaseOf(p.parent);
      // The anonymous class itself first (a method its body declares), then what it extends.
      if (base) out.push(anonymousClassName(p.parent)!, base);
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Whether an anonymous class types what it initializes: a `var` (no stated type) or a declared type naming the
 * class's own base, where the synthetic class is a refinement. Any other stated type (`Map<String, Club> m = new
 * HashMap<>() {{ ... }}`, `Base b = new Impl() { ... }`) is the declared supertype and stays.
 */
export function anonymousRefinesDeclared(declared: string | null | undefined, creation: Node): boolean {
  const text = declared?.trim();
  if (!text || text === "var") return true;
  const base = anonymousBaseOf(creation)?.split(".").pop();
  const simple = text.replace(/<[\s\S]*$/, "").replace(/\s+/g, "").split(".").pop();
  return !!base && simple === base;
}

/** Cheap text gate: whether a Java source can hold an anonymous class (`new X(...) {`). */
export function mayHoldAnonymousClass(source: string): boolean {
  return /\bnew\b[^;]*\)\s*\{/.test(source);
}
