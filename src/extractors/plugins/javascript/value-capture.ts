/**
 * JavaScript/TypeScript value capture — the syntactic half of value resolution.
 *
 * Maps a tree-sitter expression node to the language-agnostic {@link ValueExpr}
 * IR that {@link foldValue} partially evaluates. Capture is inherently
 * per-language (it reads node types); the folding it feeds is shared. Together
 * they replace the several bespoke string-folders that used to live in the JS
 * plugin (`extractUrlTemplate`, `resolveConstString`/`resolveTemplateUrl`).
 */

import type { Node } from "web-tree-sitter";
import { stripQuotes } from "../../shared/node-helpers.js";
import type { Scope, ValueExpr } from "../../shared/value-resolver.js";

const OPAQUE_EMPTY: ValueExpr = { kind: "opaque", text: "" };

/** The env-var name of an `import.meta.env.X` / `process.env.X` read, else null. */
function envRead(node: Node): string | null {
  const t = node.text;
  if (!t.startsWith("import.meta.env") && !t.startsWith("process.env")) return null;
  if (node.type === "member_expression") {
    const prop = node.childForFieldName("property");
    if (prop && prop.type === "property_identifier") return prop.text;
  }
  if (node.type === "subscript_expression") {
    const idx = node.childForFieldName("index");
    if (idx && idx.type === "string") return stripQuotes(idx.text);
  }
  return t; // bare `import.meta.env` / dynamic property — keep the whole text
}

export interface CaptureOptions {
  /**
   * When true, `??` / `||` map to a {@link ValueExpr} `coalesce` (resolving the
   * env-default idiom) — used by the const-map / api-call URL path. When false
   * (default), a non-`+` binary is an opaque hole, matching the legacy
   * `extractUrlTemplate` semantics exactly.
   */
  logical?: boolean;
}

/**
 * Convert a JS/TS expression node to the value IR. Unresolvable/runtime nodes
 * become `opaque` (→ `{}`); an environment read becomes `env`; an identifier
 * becomes `ref` (resolved later through a {@link Scope} + a params set).
 */
export function astToValueExpr(node: Node | null, opts: CaptureOptions = {}): ValueExpr {
  if (!node) return OPAQUE_EMPTY;
  switch (node.type) {
    case "string":
      return { kind: "lit", value: stripQuotes(node.text) };
    case "template_string": {
      const parts: ValueExpr[] = [];
      for (const part of node.children) {
        if (part.type === "`") continue;
        if (part.type === "template_substitution") {
          parts.push(astToValueExpr(part.namedChild(0), opts));
        } else {
          parts.push({ kind: "lit", value: part.text }); // string_fragment / escape_sequence
        }
      }
      return { kind: "template", parts };
    }
    case "binary_expression": {
      const op = node.childForFieldName("operator")?.text;
      if (op === "+") {
        return {
          kind: "concat",
          parts: [
            astToValueExpr(node.childForFieldName("left"), opts),
            astToValueExpr(node.childForFieldName("right"), opts),
          ],
        };
      }
      if (opts.logical && (op === "??" || op === "||")) {
        // Prefer the (default) right operand, mirroring the old
        // `resolveConstString(right) ?? resolveConstString(left)`.
        return {
          kind: "coalesce",
          parts: [
            astToValueExpr(node.childForFieldName("right"), opts),
            astToValueExpr(node.childForFieldName("left"), opts),
          ],
        };
      }
      return { kind: "opaque", text: node.text };
    }
    case "parenthesized_expression":
    case "non_null_expression":
    case "as_expression":
    case "satisfies_expression":
      return astToValueExpr(node.namedChild(0), opts);
    case "identifier":
      return { kind: "ref", name: node.text };
    case "member_expression":
    case "subscript_expression": {
      const en = envRead(node);
      return en != null ? { kind: "env", name: en } : { kind: "opaque", text: node.text };
    }
    default:
      return { kind: "opaque", text: node.text };
  }
}

/**
 * Build a file-wide {@link Scope} from every `X = <expr>` variable binding,
 * FIRST-WINS per name — matching the legacy file-local URL-const map, which was
 * also file-wide first-wins. (JS has no precise per-function scoping here, so a
 * later same-named binding in another function is ignored rather than treated as
 * a conflict, which would wrongly nuke ubiquitous locals like `url`/`id`.) Used
 * by the api-call URL capture for cross-statement, same-file resolution.
 */
export function buildScope(root: Node, opts: CaptureOptions = {}): Scope {
  const scope = new Map<string, ValueExpr | null>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const value = n.childForFieldName("value");
      if (name && name.type === "identifier" && value && !scope.has(name.text)) {
        scope.set(name.text, astToValueExpr(value, opts));
      }
    }
    for (const c of n.children) stack.push(c);
  }
  return scope;
}
