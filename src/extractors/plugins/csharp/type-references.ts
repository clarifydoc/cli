import type { Node, Tree } from "web-tree-sitter";
import type { TypeReference } from "../../../types/analysis.js";
import { emitParsed, findChildByType, lineOf } from "../../shared/type-ref-helpers.js";

/**
 * AST-level type-reference walker for C#: local declarations, casts,
 * object creation, and typed lambda parameters.
 */
export function extractCsharpTypeReferences(
  tree: Tree,
  filePath: string,
): TypeReference[] {
  const refs: TypeReference[] = [];
  if (!tree || !tree.rootNode) return refs;
  walkCsharp(tree.rootNode, filePath, "(top-level)", undefined, refs);
  return refs;
}

function walkCsharp(
  node: Node,
  filePath: string,
  enclosing: string,
  enclosingClass: string | undefined,
  out: TypeReference[],
): void {
  const t = node.type;

  let here = enclosing;
  let hereClass = enclosingClass;
  if (t === "method_declaration" || t === "constructor_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (name) here = name;
  } else if (t === "class_declaration" || t === "interface_declaration"
             || t === "struct_declaration" || t === "record_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (name) { here = name; hereClass = name; }
  }

  if (t === "local_declaration_statement") {
    const vd = findChildByType(node, "variable_declaration");
    if (vd) {
      const typeNode = vd.childForFieldName("type") ?? vd.child(0);
      if (typeNode) {
        emitParsed(typeNode.text, "csharp", "variable", filePath, lineOf(node), enclosing, enclosingClass, out);
      }
    }
  }

  if (t === "cast_expression") {
    const typeNode = node.childForFieldName("type") ?? node.child(1);
    if (typeNode) {
      emitParsed(typeNode.text, "csharp", "cast", filePath, lineOf(node), enclosing, enclosingClass, out);
    }
  }

  if (t === "object_creation_expression") {
    const typeNode = node.childForFieldName("type");
    if (typeNode) {
      emitParsed(typeNode.text, "csharp", "instantiation", filePath, lineOf(node), enclosing, enclosingClass, out, "INFERRED");
    }
  }

  if (t === "lambda_expression") {
    const params = node.childForFieldName("parameters");
    if (params) {
      for (const p of params.children) {
        if (!p) continue;
        const typeNode = p.childForFieldName?.("type");
        if (typeNode) {
          emitParsed(typeNode.text, "csharp", "parameter", filePath, lineOf(p), enclosing, enclosingClass, out);
        }
      }
    }
  }

  for (const child of node.children) {
    if (child) walkCsharp(child, filePath, here, hereClass, out);
  }
}
