import type { Node, Tree } from "web-tree-sitter";
import type { ModuleNameSpan } from "../../../types/analysis.js";
import { moduleNameSpans } from "../../shared/module-name-spans.js";

/** The identifiers an assignment target binds: `x`, `a, b`, `(a, b)`, `[a, *rest]`; an attribute or subscript binds none. */
function targetNames(node: Node | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (node.type === "pattern_list" || node.type === "tuple_pattern" || node.type === "list_pattern" || node.type === "list_splat_pattern") return node.namedChildren.flatMap(targetNames);
  return [];
}

/** Names bound by a top-level `X = …`, `X: T = …`, `X += …` or a chain `a = b = …`. */
function assignedNames(top: Node): string[] {
  if (top.type !== "expression_statement") return [];
  const out: string[] = [];
  let node: Node | null = top.namedChild(0);
  while (node && (node.type === "assignment" || node.type === "augmented_assignment")) {
    out.push(...targetNames(node.childForFieldName("left")));
    node = node.childForFieldName("right");
  }
  return out;
}

/**
 * `FileAnalysis.moduleNames` for Python: the module-level assignments and the lines each owns. This is what `impact`
 * uses to charge only the importers that read an edited constant: a module imported whole (`from p import m`) counts as
 * a reader, spelled by the module's own stem; a value derived from the name in another file (`CAP = LIMIT * 2`) hands
 * nothing on, and a line inserted right after a name reads as an edit of it.
 */
export function extractPythonModuleNames(tree: Tree): ModuleNameSpan[] {
  return moduleNameSpans(tree, assignedNames);
}
