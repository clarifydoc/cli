import type { Node } from "web-tree-sitter";
import type { ImportInfo } from "../../../types/analysis.js";
import { buildImportMaps, isNestedScopeType } from "../../shared/call-graph.js";

/**
 * Extract variable-to-call assignments from module-level code.
 * Returns a map: variable name → import source (resolved through imports).
 * E.g., `const userStore = useUserStore()` → { "userStore": "../stores/users" }
 */
export function extractJsVariableAliases(
  tree: { rootNode: Node },
  imports: ImportInfo[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  const { importMap } = buildImportMaps(imports);

  function walk(node: Node) {
    // Stop at function/class boundaries
    if (isNestedScopeType(node.type) ||
        node.type === "function_declaration" ||
        node.type === "class_declaration") return;

    // Match: const/let/var name = importedFn()
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const decl of node.children) {
        if (decl.type === "variable_declarator") {
          const nameNode = decl.childForFieldName("name");
          const valueNode = decl.childForFieldName("value");
          if (nameNode && valueNode && valueNode.type === "call_expression") {
            const fnNode = valueNode.childForFieldName("function");
            const fnName = fnNode?.text;
            if (fnName && importMap.has(fnName)) {
              aliases.set(nameNode.text, importMap.get(fnName)!);
            }
          }
        }
      }
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return aliases;
}
