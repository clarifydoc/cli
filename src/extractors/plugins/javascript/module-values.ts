import type { Node, Tree } from "web-tree-sitter";
import { renderUrlExpr } from "./url-expr.js";

/** Cheap gate: a string literal containing a `/` somewhere in the file, or a member named like a route path. */
const URLISH_LITERAL = /['"`][^'"`\n]*\/|\b\w*(?:[pP]ath|[rR]oute)\s*:/;
/** A member whose value is a route path even without a `/` (`detailsPath: 'squad'`). */
const PATH_MEMBER = /(?:^|\.)\w*(?:[pP]ath|[rR]oute)$/;

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
  // A string enum's members (`enum ReportKey { squad = 'squad' }`): what a computed key `[ReportKey.squad]` is.
  const enumValues = new Map<string, string>();
  for (const e of tree.rootNode.descendantsOfType("enum_declaration")) {
    const enumName = e?.childForFieldName("name")?.text;
    for (const m of e?.childForFieldName("body")?.namedChildren ?? []) {
      if (m.type !== "enum_assignment") continue;
      const key = m.childForFieldName("name")?.text.replace(/^['"]|['"]$/g, "");
      const value = m.childForFieldName("value");
      if (enumName && key && value?.type === "string") enumValues.set(`${enumName}.${key}`, value.text.slice(1, -1));
    }
  }

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
          const name = k?.type === "string" ? k.text.slice(1, -1)
            : k?.type === "computed_property_name" ? enumValues.get(k.text.slice(1, -1).trim()) ?? null
            : k?.text;
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
    // An endpoint table: URL-shaped values, API versions (`'v1'`) that URLs splice in, and route paths a member names.
    const routePath = PATH_MEMBER.test(key) && /^[\w\-:.*]+$/.test(resolved);
    if ((!resolved.includes("/") && !/^v?\d+(?:\.\d+)*$/.test(resolved) && !routePath) || kept >= 200) continue;
    out[key] = resolved;
    kept++;
  }
  return out;
}
