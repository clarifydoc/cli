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
    case "ternary_expression": {
      // `${params.length ? `?${params.join("&")}` : ""}` — an optional query
      // string: the request goes to the same path either way, so the arm that
      // writes it out stands for both. Any other choice stays one hole.
      const arms = [node.childForFieldName("consequence"), node.childForFieldName("alternative")].map(unparenthesized);
      const empty = arms.findIndex((a) => a !== null && isEmptyString(a));
      const other = empty === -1 ? null : arms[1 - empty];
      if (other && (other.type === "string" || other.type === "template_string") && /^.[?&#]/.test(other.text)) return astToValueExpr(other, opts);
      return { kind: "opaque", text: node.text };
    }
    case "identifier":
      return { kind: "ref", name: node.text };
    case "call_expression": {
      // `[club, season].join("/")`, `[a, b].map(encodeURIComponent).join("/")`: the elements, joined —
      // so a path built from parts keeps one hole per segment.
      const joined = joinedArray(node);
      if (joined) {
        const parts: ValueExpr[] = [];
        joined.items.forEach((item, i) => {
          if (i > 0) parts.push({ kind: "lit", value: joined.separator });
          parts.push(astToValueExpr(item, opts));
        });
        return { kind: "concat", parts };
      }
      return { kind: "opaque", text: node.text };
    }
    case "member_expression":
    case "subscript_expression": {
      const en = envRead(node);
      return en != null ? { kind: "env", name: en } : { kind: "opaque", text: node.text };
    }
    default:
      return { kind: "opaque", text: node.text };
  }
}

/** An array literal joined by a literal separator, through any element-wise `.map(fn)`; null otherwise. */
function joinedArray(call: Node): { items: Node[]; separator: string } | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "join") return null;
  const sep = call.childForFieldName("arguments")?.namedChildren;
  if (sep?.length !== 1 || sep[0]!.type !== "string") return null;
  let array = fn.childForFieldName("object");
  // `.map(encodeURIComponent)`, `.map(String)`: one element in, one out.
  while (array?.type === "call_expression") {
    const inner = array.childForFieldName("function");
    const mapper = array.childForFieldName("arguments")?.namedChildren;
    if (inner?.type !== "member_expression" || inner.childForFieldName("property")?.text !== "map" || mapper?.length !== 1 ||
      !/^(?:identifier|member_expression)$/.test(mapper[0]!.type)) return null;
    array = inner.childForFieldName("object");
  }
  if (array?.type !== "array" || array.namedChildren.some((c) => c.type === "spread_element")) return null;
  const items = array.namedChildren.filter((c) => c.type !== "comment");
  return items.length > 0 && items.length <= 8 ? { items, separator: stripQuotes(sep[0]!.text) } : null;
}

function unparenthesized(node: Node | null): Node | null {
  let n = node;
  while (n?.type === "parenthesized_expression") n = n.namedChild(0);
  return n;
}

/** `""`, `''` or an empty template literal. */
function isEmptyString(node: Node): boolean {
  return (node.type === "string" || node.type === "template_string") && node.text.length === 2;
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
