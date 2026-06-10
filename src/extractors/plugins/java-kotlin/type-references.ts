import type { Node, Tree } from "web-tree-sitter";
import type { Language, TypeReference } from "../../../types/analysis.js";
import { emitParsed, lineOf } from "../../shared/type-ref-helpers.js";

/**
 * AST-level type-reference walker for Java / Kotlin: local variable
 * declarations, casts, object creation, and typed lambda parameters.
 */
export function extractJavaKotlinTypeReferences(
  tree: Tree,
  language: Language,
  filePath: string,
): TypeReference[] {
  const refs: TypeReference[] = [];
  if (!tree || !tree.rootNode) return refs;
  walkJavaLike(tree.rootNode, language, filePath, "(top-level)", undefined, refs);
  return refs;
}

function walkJavaLike(
  node: Node,
  language: Language,
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
             || t === "enum_declaration" || t === "record_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (name) { here = name; hereClass = name; }
  }

  if (t === "local_variable_declaration") {
    const typeNode = node.childForFieldName("type") ?? node.child(0);
    if (typeNode) {
      emitParsed(typeNode.text, language, "variable", filePath, lineOf(node), enclosing, enclosingClass, out);
    }
  }

  if (t === "cast_expression") {
    const typeNode = node.childForFieldName("type") ?? node.child(1);
    if (typeNode) {
      emitParsed(typeNode.text, language, "cast", filePath, lineOf(node), enclosing, enclosingClass, out);
    }
  }

  if (t === "object_creation_expression") {
    const typeNode = node.childForFieldName("type") ?? node.childForFieldName("constructor");
    if (typeNode) {
      emitParsed(typeNode.text, language, "instantiation", filePath, lineOf(node), enclosing, enclosingClass, out, "INFERRED");
    }
  }

  if (t === "lambda_expression") {
    const params = node.childForFieldName("parameters");
    if (params) {
      for (const p of params.children) {
        if (!p) continue;
        if (p.type === "formal_parameter" || p.type === "inferred_parameters") {
          const typeNode = p.childForFieldName("type");
          if (typeNode) {
            emitParsed(typeNode.text, language, "parameter", filePath, lineOf(p), enclosing, enclosingClass, out);
          }
        }
      }
    }
  }

  for (const child of node.children) {
    if (child) walkJavaLike(child, language, filePath, here, hereClass, out);
  }
}
