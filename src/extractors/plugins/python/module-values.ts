import type { Node, Tree } from "web-tree-sitter";

/**
 * A Python module's string values, by name → `FileAnalysis.moduleValues`:
 * module-level `CLUBS_URL = "/api/v2/clubs"` and class attributes
 * `class Paths: MATCHES = "/api/v2/matches"` (as `Paths.MATCHES`). A value
 * built from others (`CLUB_URL = CLUBS_URL + "/{id}"`, `f"{BASE}/clubs"`)
 * keeps each name it reads as a `${…}` hole, which the project pass fills in
 * this file's scope (`core/module-values.ts`). A name bound twice, or bound to
 * anything else, is left out.
 */
export function extractPythonModuleValues(tree: Tree): Record<string, string> {
  const out = new Map<string, string>();
  const clash = new Set<string>();
  const read = (body: Node, prefix: string): void => {
    for (const stmt of body.namedChildren) {
      if (stmt.type === "class_definition" && !prefix) {
        const name = stmt.childForFieldName("name")?.text;
        const inner = stmt.childForFieldName("body");
        if (name && inner) read(inner, `${name}.`);
        continue;
      }
      if (stmt.type !== "expression_statement") continue;
      const a = stmt.namedChild(0);
      if (a?.type !== "assignment") continue;
      const left = a.childForFieldName("left");
      const right = a.childForFieldName("right");
      if (left?.type !== "identifier" || !right) continue;
      const built = stringExpr(right, prefix, 0);
      // A value must hold some text of its own: `router = api_router` is no string.
      const value = built !== null && built.replace(/\$\{[^}]*\}/g, "") ? built : null;
      const key = prefix + left.text;
      if (value === null || (out.has(key) && out.get(key) !== value)) {
        if (out.has(key) || value === null) clash.add(key);
        continue;
      }
      out.set(key, value);
    }
  };
  read(tree.rootNode, "");
  for (const k of clash) out.delete(k);
  return Object.fromEntries(out);
}

/** A string expression as a template (`CLUBS_URL + "/<id>"` → `${CLUBS_URL}/<id>`); null for anything else. */
export function pythonStringTemplate(n: Node): string | null {
  return stringExpr(n, "", 0);
}

/** A string expression's text: literals as written, names as `${…}` holes; null for anything else. */
function stringExpr(n: Node, classPrefix: string, depth: number): string | null {
  if (depth > 8) return null;
  switch (n.type) {
    case "string": {
      const m = /^([a-zA-Z]*)("""|'''|"|')([\s\S]*)\2$/.exec(n.text);
      if (!m || /[bB]/.test(m[1]!)) return null;
      // An f-string's `{name}` / `{mod.NAME}` holes read other values; a format spec or call leaves it out.
      if (/[fF]/.test(m[1]!)) {
        let ok = true;
        const text = m[3]!.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (whole, inner: string | undefined) => {
          if (inner === undefined) return whole[0]!;
          if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(inner.trim())) ok = false;
          return `\${${inner.trim()}}`;
        });
        return ok ? text : null;
      }
      return m[3]!.includes("\\") ? null : m[3]!;
    }
    case "concatenated_string": {
      const parts = n.namedChildren.map((c) => stringExpr(c, classPrefix, depth + 1));
      return parts.every((p) => p !== null) ? parts.join("") : null;
    }
    case "parenthesized_expression":
      return n.namedChild(0) ? stringExpr(n.namedChild(0)!, classPrefix, depth + 1) : null;
    case "identifier":
      // Inside a class body a bare name is another attribute of the class.
      return `\${${classPrefix && !/^[A-Z][A-Z0-9_]*$/.test(n.text) ? "" : classPrefix}${n.text}}`;
    case "attribute":
      return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(n.text) ? `\${${n.text}}` : null;
    case "binary_operator": {
      if (n.childForFieldName("operator")?.text !== "+") return null;
      const l = n.childForFieldName("left");
      const r = n.childForFieldName("right");
      const lv = l ? stringExpr(l, classPrefix, depth + 1) : null;
      const rv = lv !== null && r ? stringExpr(r, classPrefix, depth + 1) : null;
      // `A + B` of two bare names says nothing a string does: one side must be text.
      if (lv === null || rv === null || (!lv.replace(/\$\{[^}]*\}/g, "") && !rv.replace(/\$\{[^}]*\}/g, ""))) return null;
      return lv + rv;
    }
  }
  return null;
}
