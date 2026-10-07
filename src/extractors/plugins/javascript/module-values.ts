import type { Node, Tree } from "web-tree-sitter";
import { renderUrlExpr } from "./url-expr.js";

/** Cheap gate: a string literal containing a `/` somewhere in the file. */
const URLISH_LITERAL = /['"`][^'"`\n]*\//;

/**
 * URL-shaped values a module defines at its top level, keyed by name (an
 * object's members by `name.member`, three levels deep):
 *
 *     const IP = 'localhost';
 *     export const environment = { apiUrl: 'http://' + IP + ':5000/api/' };
 *       → { "environment.apiUrl": "http://localhost:5000/api/" }
 *     const PREFIX = "/api"; export const config = { PREFIX };
 *       → { "PREFIX": "/api", "config.PREFIX": "/api" }
 *
 * A service elsewhere sets `baseUrl = environment.apiUrl`; the project pass
 * that resolves `${this.baseUrl}` in a call's URL follows the import to this
 * table. Values reference each other within the file and are substituted
 * here; what stays unknown stays a `${…}` hole. Only values with a `/`, and
 * API versions (`'v1'`), are kept — an endpoint table, not every string
 * constant.
 */
export function extractModuleValues(tree: Tree, sourceText: string): Record<string, string> {
  if (!URLISH_LITERAL.test(sourceText)) return {};
  const raw = new Map<string, string>();

  const collect = (key: string, value: Node | null, depth: number): void => {
    let v = value;
    while (v && (v.type === "as_expression" || v.type === "satisfies_expression" || v.type === "parenthesized_expression")) {
      v = v.namedChild(0);
    }
    if (!v) return;
    if (v.type === "object") {
      if (depth >= 3) return;
      for (const member of v.namedChildren) {
        if (member.type === "pair") {
          const k = member.childForFieldName("key");
          const name = k?.type === "string" ? k.text.slice(1, -1) : k?.text;
          if (name && /^[\w$]+$/.test(name)) collect(`${key}.${name}`, member.childForFieldName("value"), depth + 1);
        } else if (member.type === "shorthand_property_identifier") {
          raw.set(`${key}.${member.text}`, `\${${member.text}}`);
        }
      }
      return;
    }
    const rendered = renderUrlExpr(v);
    if (rendered !== null && rendered.length <= 300) raw.set(key, rendered);
  };

  for (const stmt of tree.rootNode.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
    if (!decl || (decl.type !== "lexical_declaration" && decl.type !== "variable_declaration")) continue;
    for (const d of decl.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      if (name?.type === "identifier") collect(name.text, d.childForFieldName("value"), 0);
    }
  }

  const resolve = (value: string, depth: number): string =>
    value.replace(/\$\{([\w$.]+)\}/g, (hole, ref: string) => {
      const bound = raw.get(ref);
      return depth < 4 && bound !== undefined ? resolve(bound, depth + 1) : hole;
    });
  const out: Record<string, string> = {};
  let kept = 0;
  for (const [key, value] of raw) {
    const resolved = resolve(value, 0);
    // An endpoint table: URL-shaped values, and API versions (`'v1'`) that URLs splice in.
    if ((!resolved.includes("/") && !/^v?\d+(?:\.\d+)*$/.test(resolved)) || kept >= 200) continue;
    out[key] = resolved;
    kept++;
  }
  return out;
}
