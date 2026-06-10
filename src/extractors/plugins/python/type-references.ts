import type { Node, Tree } from "web-tree-sitter";
import type { TypeReference } from "../../../types/analysis.js";
import { emitParsed, lineOf } from "../../shared/type-ref-helpers.js";

/**
 * AST-level type-reference walker for Python: annotated assignments
 * (`x: User = ...`).
 */
export function extractPythonTypeReferences(
  tree: Tree,
  filePath: string,
): TypeReference[] {
  const refs: TypeReference[] = [];
  if (!tree || !tree.rootNode) return refs;
  walkPython(tree.rootNode, filePath, "(top-level)", undefined, refs);
  return refs;
}

function walkPython(
  node: Node,
  filePath: string,
  enclosing: string,
  enclosingClass: string | undefined,
  out: TypeReference[],
): void {
  const t = node.type;

  let here = enclosing;
  let hereClass = enclosingClass;
  if (t === "function_definition") {
    const name = node.childForFieldName("name")?.text;
    if (name) here = name;
  } else if (t === "class_definition") {
    const name = node.childForFieldName("name")?.text;
    if (name) { here = name; hereClass = name; }
  }

  if (t === "assignment") {
    const typeNode = node.childForFieldName("type");
    if (typeNode) {
      const nameNode = node.childForFieldName("left");
      emitParsed(typeNode.text, "python", "variable", filePath, lineOf(node),
        nameNode ? (enclosing === "(top-level)" ? nameNode.text : `${enclosing}.${nameNode.text}`) : enclosing,
        enclosingClass, out);
    }
  }

  for (const child of node.children) {
    if (child) walkPython(child, filePath, here, hereClass, out);
  }
}
