import type { Node } from "web-tree-sitter";

/**
 * A compile-time string expression as text: a literal, or a concatenation of
 * literals and other constants (`CLUBS + "/{id}"`, `ApiPaths.BASE + "/clubs"`),
 * each constant kept as a `${…}` hole a project pass fills from the class that
 * declares it (`core/module-values.ts`). Constants are recognised by their
 * spelling — `UPPER_CASE`, or `Type.UPPER_CASE` — so a local or a parameter
 * never becomes a hole. Null for anything else (a call, an interpolation).
 */
export function constantString(n: Node | null | undefined, depth = 0): string | null {
  if (!n || depth > 8) return null;
  switch (n.type) {
    case "string_literal": {
      const text = n.text;
      return /^"[^"\\$]*"$/.test(text) ? text.slice(1, -1) : null;
    }
    // Kotlin: `"…"` is a `string_literal` holding `string_content`; a template (`$x`) is no constant.
    case "parenthesized_expression":
      return constantString(n.namedChildren[0], depth + 1);
    case "identifier":
    case "simple_identifier":
      return /^[A-Z][A-Z0-9_]*$/.test(n.text) ? `\${${n.text}}` : null;
    case "field_access":
    case "navigation_expression":
      return /^[A-Z]\w*(?:\.[A-Za-z_]\w*)*\.[A-Z][A-Z0-9_]*$/.test(n.text) ? `\${${n.text}}` : null;
    case "binary_expression":
    case "additive_expression": {
      const op = n.childForFieldName("operator")?.text ?? n.children.find((c) => c.type === "+")?.text;
      if (op !== "+") return null;
      const [left, right] = n.type === "binary_expression"
        ? [n.childForFieldName("left"), n.childForFieldName("right")]
        : [n.namedChildren[0], n.namedChildren[1]];
      const l = constantString(left, depth + 1);
      const r = l === null ? null : constantString(right, depth + 1);
      return l === null || r === null ? null : l + r;
    }
  }
  return null;
}
