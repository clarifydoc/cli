import type { Node } from "web-tree-sitter";
import { stripQuotes } from "../../shared/node-helpers.js";

/**
 * A JS/TS expression rendered as a URL string with `${…}` holes for what is
 * not literal — the notation api-call targets already use:
 *
 *     environment.apiUrl + 'kavita-plus-audit/'   → ${environment.apiUrl}kavita-plus-audit/
 *     `${this.baseUrl}${this.resourceName}/`       → ${this.baseUrl}${this.resourceName}/
 *     import.meta.env.VITE_API ?? '/api'          → /api
 *
 * Holes keep their source text so a project pass can still resolve them (a
 * field, an imported constant). Null for anything that is not string-shaped:
 * a call, an object, arithmetic.
 */
export function renderUrlExpr(node: Node | null): string | null {
  let n = node;
  while (n && (n.type === "parenthesized_expression" || n.type === "as_expression" || n.type === "satisfies_expression" || n.type === "non_null_expression")) {
    n = n.namedChild(0);
  }
  if (!n) return null;
  switch (n.type) {
    case "string":
      return stripQuotes(n.text);
    case "template_string": {
      let out = "";
      for (const part of n.children) {
        if (part.type === "`") continue;
        out += part.type === "template_substitution" ? `\${${part.namedChild(0)?.text ?? ""}}` : part.text;
      }
      return out;
    }
    case "identifier":
    case "member_expression":
      return `\${${n.text.replace(/\s+/g, "")}}`;
    case "binary_expression": {
      const op = n.childForFieldName("operator")?.text;
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      // The env-default idiom: `import.meta.env.X ?? '/path'` is `/path` in source.
      if (op === "??" || op === "||") return right?.type === "string" ? stripQuotes(right.text) : null;
      if (op !== "+") return null;
      const l = renderUrlExpr(left);
      const r = renderUrlExpr(right);
      if (l === null || r === null) return null;
      // `a + b` is a URL only when some piece is literal text.
      return /\$\{[^}]*\}$/.test(l) && /^\$\{[^}]*\}/.test(r) && !hasLiteral(left!) && !hasLiteral(right!) ? null : l + r;
    }
    default:
      return null;
  }
}

function hasLiteral(n: Node): boolean {
  if (n.type === "string" || n.type === "template_string") return true;
  return n.type === "binary_expression" && (hasLiteral(n.childForFieldName("left")!) || hasLiteral(n.childForFieldName("right")!));
}
