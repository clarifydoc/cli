import type { Node, Tree } from "web-tree-sitter";
import type { ModuleNameSpan } from "../../../types/analysis.js";
import { moduleNameSpans } from "../../shared/module-name-spans.js";

/** The names a declarator's pattern binds: `x`, `{ a, b: c }`, `[a, ...rest]`. */
function patternNames(node: Node | null): string[] {
  if (!node) return [];
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      return [node.text];
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
      return node.namedChildren.flatMap(patternNames);
    case "pair_pattern":
      return patternNames(node.childForFieldName("value"));
    case "assignment_pattern":
    case "object_assignment_pattern":
      return patternNames(node.childForFieldName("left"));
    default:
      return [];
  }
}

/** Names bound by a top-level `const`/`let`/`var`, exported or not. */
function declaredNames(top: Node): string[] {
  const decl = top.type === "export_statement" ? top.childForFieldName("declaration") : top;
  if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") return [];
  return decl.namedChildren.filter((d) => d.type === "variable_declarator").flatMap((d) => patternNames(d.childForFieldName("name")));
}

/** `FileAnalysis.moduleNames` for JS/TS: the top-level `const`/`let`/`var` names and the lines each owns. */
export function extractJsModuleNames(tree: Tree): ModuleNameSpan[] {
  return moduleNameSpans(tree, declaredNames);
}
