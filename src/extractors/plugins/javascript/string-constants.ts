import type { Node, Tree } from "web-tree-sitter";

/** Most constants one file reports. */
const MAX_CONSTANTS = 200;
/** Longest value kept: a name, an action type, a key — not a message. */
const MAX_VALUE = 120;
const KEEPABLE = /^[^\s'"`\\]+$/;
const WRAPPERS = new Set(["as_expression", "satisfies_expression", "parenthesized_expression", "non_null_expression"]);

/**
 * String constants a module defines at its top level, by name (`FileAnalysis.stringConstants`):
 *
 *     export const LOAD_CLUBS = 'clubs/load';                              → LOAD_CLUBS
 *     export const ACTIONS = { FETCH_CLUBS: 'clubs/fetch' } as const;      → ACTIONS.FETCH_CLUBS
 *     export enum Kind { Club = 'club' }                                   → Kind.Club
 *
 * A value a program names by another file's constant (`dispatch(ACTIONS.FETCH_CLUBS)`, `[ACTIONS.FETCH_CLUBS]() {}`,
 * `{ [Kind.Club]: useClubStore() }`) is read from the file that declares it. Plain values only — no spaces, no
 * template holes; an object's members two levels deep, `Object.freeze({…})` read through.
 */
export function extractStringConstants(tree: Tree, sourceText: string): Record<string, string> {
  if (!/\b(?:const|enum)\b/.test(sourceText)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  const put = (key: string, value: string | null): void => {
    if (value === null || count >= MAX_CONSTANTS || value.length === 0 || value.length > MAX_VALUE || !KEEPABLE.test(value)) return;
    if (!(key in out)) count++;
    out[key] = value;
  };
  const literal = (n: Node | null): string | null => {
    let v = n;
    while (v && WRAPPERS.has(v.type)) v = v.namedChild(0);
    if (v?.type === "string") return v.text.slice(1, -1);
    if (v?.type === "template_string" && !v.namedChildren.some((c) => c?.type === "template_substitution")) return v.text.slice(1, -1);
    return null;
  };
  const collect = (key: string, value: Node | null, depth: number): void => {
    let v = value;
    while (v && WRAPPERS.has(v.type)) v = v.namedChild(0);
    // `Object.freeze({ … })`
    if (v?.type === "call_expression" && v.childForFieldName("function")?.text === "Object.freeze") v = v.childForFieldName("arguments")?.namedChild(0) ?? null;
    while (v && WRAPPERS.has(v.type)) v = v.namedChild(0);
    if (!v) return;
    if (v.type === "object") {
      if (depth >= 2) return;
      for (const member of v.namedChildren) {
        if (member?.type !== "pair") continue;
        const k = member.childForFieldName("key");
        const name = k?.type === "string" ? k.text.slice(1, -1) : k?.type === "property_identifier" || k?.type === "identifier" ? k.text : null;
        if (name && /^[\w$]+$/.test(name)) collect(`${key}.${name}`, member.childForFieldName("value"), depth + 1);
      }
      return;
    }
    put(key, literal(v));
  };
  for (const stmt of tree.rootNode.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
    if (!decl) continue;
    if (decl.type === "lexical_declaration" && decl.child(0)?.type === "const") {
      for (const d of decl.namedChildren) {
        if (d?.type !== "variable_declarator") continue;
        const name = d.childForFieldName("name");
        if (name?.type === "identifier") collect(name.text, d.childForFieldName("value"), 0);
      }
    } else if (decl.type === "enum_declaration") {
      const enumName = decl.childForFieldName("name")?.text;
      for (const m of decl.childForFieldName("body")?.namedChildren ?? []) {
        if (m?.type !== "enum_assignment") continue;
        const key = m.childForFieldName("name")?.text.replace(/^['"]|['"]$/g, "");
        if (enumName && key && /^[\w$]+$/.test(key)) put(`${enumName}.${key}`, literal(m.childForFieldName("value")));
      }
    }
  }
  return out;
}
