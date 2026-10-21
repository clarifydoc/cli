import type { Tree } from "web-tree-sitter";
import type { Instantiation } from "../../../types/analysis.js";
import { renderUrlExpr } from "./url-expr.js";

/**
 * `new X("rooms")` with a string among its arguments (`FileAnalysis.instantiations`):
 *
 *     export const roomCascadeService = new CascadeService("rooms");
 *
 * A generic client configured per instance, the way a subclass configures it
 * through `super("rooms")`. Arguments render as `ClassInfo.superArgs` do; the
 * core reads each instance's base-class requests with them.
 */
export function extractInstantiations(tree: Tree, sourceText: string): Instantiation[] {
  if (!sourceText.includes("new ")) return [];
  const out: Instantiation[] = [];
  for (const node of tree.rootNode.descendantsOfType("new_expression")) {
    if (!node) continue;
    const ctor = node.childForFieldName("constructor");
    if (ctor?.type !== "identifier" || !/^[A-Z]/.test(ctor.text)) continue;
    const argNodes = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
    if (!argNodes.some((a) => a.type === "string" || a.type === "template_string")) continue;
    const decl = node.parent?.type === "variable_declarator" ? node.parent.childForFieldName("name") : null;
    out.push({
      className: ctor.text,
      args: argNodes.map((a) => renderUrlExpr(a) ?? `\${${a.text}}`),
      line: node.startPosition.row + 1,
      ...(decl?.type === "identifier" ? { name: decl.text } : {}),
    });
  }
  return out;
}
