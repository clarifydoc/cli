import type { Node } from "web-tree-sitter";
import type { ParamInfo } from "../../../types/analysis.js";

/**
 * Shared readers over the tree-sitter-fsharp tree.
 */

/** Containers whose `let`s are module-level: the file, a namespace, a module (named or nested). */
export const MODULE_NODES: ReadonlySet<string> = new Set(["file", "named_module", "namespace", "module_defn"]);

/**
 * A binding that defines a FUNCTION of the module: `let f x = …`, and a
 * value that computes one (`let handler : HttpHandler = fun next ctx -> …`,
 * `let webApp = choose […]`) — not a constant (`let port = 8080`). What the
 * function extractor reports, and where the module-level `<setup>` walk stops.
 */
export function isFunctionDefn(node: Node): boolean {
  if (node.type !== "function_or_value_defn") return false;
  const left = node.namedChildren[0];
  if (left?.type === "function_declaration_left") return true;
  if (left?.type !== "value_declaration_left") return false;
  const body = node.namedChildren[node.namedChildren.length - 1];
  return !!body && body.id !== left.id && body.type !== "const" && body.type !== "long_identifier_or_op";
}

/** The name a `let` binds: `f` of `let f x`, `webApp` of `let webApp =`. */
export function bindingName(defn: Node): string | null {
  const left = defn.namedChildren[0];
  if (!left) return null;
  if (left.type === "function_declaration_left") return left.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
  if (left.type === "value_declaration_left") {
    const id = left.descendantsOfType("identifier")[0];
    return id?.text ?? null;
  }
  return null;
}

/** The expression a binding / member defines — its last named child. */
export function bodyOf(node: Node): Node | null {
  return node.namedChildren[node.namedChildren.length - 1] ?? null;
}

/** Parameters written as patterns: `(id: int)`, `x`, `(a: int, b: string)`, `()`. */
export function patternParams(nodes: readonly Node[]): ParamInfo[] {
  const out: ParamInfo[] = [];
  const visit = (n: Node) => {
    if (n.type === "typed_pattern") {
      const name = n.descendantsOfType("identifier")[0]?.text;
      const type = n.namedChildren.find((c) => /_type$/.test(c.type))?.text ?? null;
      if (name) out.push({ name, type, defaultValue: null });
      return;
    }
    if (n.type === "long_identifier" || n.type === "identifier_pattern") {
      const name = n.descendantsOfType("identifier")[0]?.text ?? (n.type === "long_identifier" ? n.text : null);
      if (name && name !== "_") out.push({ name, type: null, defaultValue: null });
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** `[<EntryPoint>]` / `[<HttpGet("x")>]` written before a declaration (`attributes` node). */
export function attributesOf(node: Node | null): string[] {
  if (!node || node.type !== "attributes") return [];
  return node.descendantsOfType("attribute").map((a) => a.text.replace(/\s+/g, " "));
}

/** A string literal's content: `"x"`, `@"x"`, `$"x"`, `"""x"""`. */
export function stringValue(node: Node): string | null {
  const s = node.type === "const" ? node.namedChildren[0] : node;
  if (!s || !/string$/.test(s.type)) return null;
  const m = /^[@$]*("""|")([\s\S]*)\1$/.exec(s.text);
  return m ? m[2]! : null;
}

/**
 * A curried application flattened: `routef "/x/%i" handler` is
 * app(app(routef, "/x/%i"), handler) → head `routef`, args [`"/x/%i"`, `handler`].
 */
export function flattenApplication(node: Node): { head: Node; args: Node[] } {
  const args: Node[] = [];
  let cur = node;
  while (cur.type === "application_expression") {
    const [fn, ...rest] = cur.namedChildren;
    args.unshift(...rest);
    if (!fn) break;
    cur = fn;
  }
  return { head: cur, args };
}

/** A callee's name: `repo.Find`, `ctx.GetService` (type arguments dropped), `List.map`. */
export function calleeName(node: Node): string | null {
  if (node.type === "long_identifier_or_op" || node.type === "long_identifier" || node.type === "identifier") {
    return /^[A-Za-z_][\w'.]*$/.test(node.text) ? node.text : null;
  }
  if (node.type === "typed_expression") return calleeName(node.namedChildren[0]!);
  if (node.type === "dot_expression") {
    const text = node.text.replace(/<[^<>]*>/g, "").replace(/\s+/g, "");
    return /^[A-Za-z_][\w'.]*$/.test(text) ? text : null;
  }
  return null;
}
