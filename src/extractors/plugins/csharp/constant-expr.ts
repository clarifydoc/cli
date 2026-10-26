import type { Node } from "web-tree-sitter";

/**
 * A C# constant string expression as text: a literal, or a concatenation of
 * literals and constants (`Clubs + "/{id}"`, `ApiRoutes.Base + "/clubs"`),
 * each constant a `${…}` hole a project pass fills from the class declaring it
 * (`core/module-values.ts`). Only read where the language demands a constant
 * (an attribute argument, a `const` initializer), so any name in it is one.
 * Null for anything else.
 */
export function constantString(n: Node | null, depth = 0): string | null {
  if (!n || depth > 8) return null;
  switch (n.type) {
    case "string_literal":
    case "verbatim_string_literal": {
      const content = n.namedChildren.find((c) => c.type === "string_literal_content");
      if (content) return /[\\"]/.test(content.text) ? null : content.text;
      const t = n.text.replace(/^@?"/, "").replace(/"$/, "");
      return /[\\"]/.test(t) ? null : t;
    }
    case "parenthesized_expression":
      return constantString(n.namedChildren[0] ?? null, depth + 1);
    case "identifier":
    case "member_access_expression":
      return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(n.text) ? `\${${n.text}}` : null;
    case "binary_expression": {
      if (n.childForFieldName("operator")?.text !== "+") return null;
      const l = constantString(n.childForFieldName("left"), depth + 1);
      const r = l === null ? null : constantString(n.childForFieldName("right"), depth + 1);
      return l === null || r === null ? null : l + r;
    }
  }
  return null;
}
