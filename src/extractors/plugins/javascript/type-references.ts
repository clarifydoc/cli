import type { Node, Tree } from "web-tree-sitter";
import type { Language, TypeReference } from "../../../types/analysis.js";
import { emitParsed, findChildByType, lineOf, stripLeadingColon } from "../../shared/type-ref-helpers.js";

/**
 * AST-level type-reference walker for TypeScript / JavaScript. Finds
 * type-position usages that don't show up in the FileAnalysis-level
 * extractor: arrow-function param/return types, variable type annotations,
 * `as` / `<T>` casts, and `new` expressions.
 */
export function extractTsTypeReferences(
  tree: Tree,
  language: Language,
  filePath: string,
): TypeReference[] {
  const refs: TypeReference[] = [];
  if (!tree || !tree.rootNode) return refs;
  walkTsLike(tree.rootNode, language, filePath, "(top-level)", undefined, refs);
  return refs;
}

function walkTsLike(
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
  if (t === "function_declaration" || t === "method_definition") {
    const name = node.childForFieldName("name")?.text;
    if (name) here = name;
  } else if (t === "class_declaration" || t === "interface_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (name) { here = name; hereClass = name; }
  }

  // Arrow function param/return types.
  if (t === "arrow_function") {
    extractTsFnTypes(node, language, filePath, enclosing || "(arrow)", enclosingClass, out);
  }

  // Variable type annotations: `const u: User = ...`, `let x: List<User>`.
  if (t === "variable_declarator") {
    const typeNode = node.childForFieldName("type")
      ?? findChildByType(node, "type_annotation");
    if (typeNode) {
      const typeStr = stripLeadingColon(typeNode.text);
      const nameNode = node.childForFieldName("name");
      const sym = nameNode?.text ?? "(variable)";
      emitParsed(typeStr, language, "variable", filePath, lineOf(node), enclosing === "(top-level)" ? sym : `${enclosing}.${sym}`, enclosingClass, out);
    }
  }

  // Type assertion: `expr as Type` (TS) / `<Type>expr` (TS).
  if (t === "as_expression" || t === "type_assertion" || t === "satisfies_expression") {
    const typeNode = node.childForFieldName("type")
      ?? findChildByType(node, "type_identifier")
      ?? findChildByType(node, "generic_type");
    if (typeNode) {
      emitParsed(typeNode.text, language, "cast", filePath, lineOf(node), enclosing, enclosingClass, out);
    }
  }

  // `new SomeClass(...)` — type-axis record (call-graph already tracks it).
  if (t === "new_expression") {
    const ctor = node.childForFieldName("constructor")
      ?? node.childForFieldName("name");
    if (ctor) {
      emitParsed(ctor.text, language, "instantiation", filePath, lineOf(node), enclosing, enclosingClass, out, "INFERRED");
    }
  }

  for (const child of node.children) {
    if (child) walkTsLike(child, language, filePath, here, hereClass, out);
  }
}

function extractTsFnTypes(
  fnNode: Node,
  language: Language,
  filePath: string,
  enclosing: string,
  enclosingClass: string | undefined,
  out: TypeReference[],
): void {
  const params = fnNode.childForFieldName("parameters")
    ?? findChildByType(fnNode, "formal_parameters");
  if (params) {
    for (const p of params.children) {
      if (!p) continue;
      if (p.type !== "required_parameter" && p.type !== "optional_parameter"
          && p.type !== "rest_pattern" && p.type !== "parameter") continue;
      const typeNode = p.childForFieldName("type")
        ?? findChildByType(p, "type_annotation");
      if (!typeNode) continue;
      emitParsed(stripLeadingColon(typeNode.text), language, "parameter", filePath, lineOf(p), enclosing, enclosingClass, out);
    }
  }
  const retTypeNode = fnNode.childForFieldName("return_type");
  if (retTypeNode) {
    emitParsed(stripLeadingColon(retTypeNode.text), language, "return", filePath, lineOf(fnNode), enclosing, enclosingClass, out);
  }
}
