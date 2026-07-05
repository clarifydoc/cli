import type { Node } from "web-tree-sitter";
import type { ImportInfo } from "../../../types/analysis.js";
import { buildImportMaps } from "../../shared/call-graph.js";

/**
 * Extract variable-to-call assignments, in any scope.
 * Returns a map: variable name → import source (resolved through imports).
 *
 * Two binding shapes, both ubiquitous in composable/hook code:
 *   - whole object:  `const userStore = useUserStore()` → userStore → "../stores/users"
 *     (lets `userStore.save()` classify as a cross-file call into that module)
 *   - destructured:  `const { refreshCart, updateCartItemQuantity } = useShopCart()`
 *     → each member name → "../composables/useShopCart"
 *     (the calls are BARE names afterwards — without this they read as
 *     unresolvable `internal` calls and every Vue/React click-handler trace
 *     dead-ends one hop from the screen)
 *
 * Bindings are collected from ALL scopes — module level for Vue `<script
 * setup>`, function bodies for React components/hooks. The map is file-global
 * and name-keyed, so a name bound to DIFFERENT sources in different scopes is
 * ambiguous: it is dropped rather than guessed (unique-or-nothing, the same
 * rule the symbol linker follows).
 */
export function extractJsVariableAliases(
  tree: { rootNode: Node },
  imports: ImportInfo[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  const conflicted = new Set<string>();
  const { importMap } = buildImportMaps(imports);

  function bind(name: string, source: string) {
    if (conflicted.has(name)) return;
    const prev = aliases.get(name);
    if (prev !== undefined && prev !== source) {
      aliases.delete(name);
      conflicted.add(name);
      return;
    }
    aliases.set(name, source);
  }

  function walk(node: Node) {
    // Match: const/let/var <pattern> = importedFn()
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const decl of node.children) {
        if (decl.type !== "variable_declarator") continue;
        const nameNode = decl.childForFieldName("name");
        let valueNode = decl.childForFieldName("value");
        if (valueNode?.type === "await_expression") {
          valueNode = valueNode.namedChild(valueNode.namedChildCount - 1) ?? valueNode;
        }
        if (!nameNode || !valueNode || valueNode.type !== "call_expression") continue;
        const fnNode = valueNode.childForFieldName("function");
        const fnName = fnNode?.text;
        if (!fnName || !importMap.has(fnName)) continue;
        const source = importMap.get(fnName)!;

        if (nameNode.type === "identifier") {
          bind(nameNode.text, source);
        } else if (nameNode.type === "object_pattern") {
          for (const prop of nameNode.namedChildren) {
            // `{ a }` → shorthand_property_identifier_pattern "a";
            // `{ a: b }` → pair_pattern whose value is the local name.
            if (prop.type === "shorthand_property_identifier_pattern") {
              bind(prop.text, source);
            } else if (prop.type === "pair_pattern") {
              const local = prop.childForFieldName("value");
              if (local?.type === "identifier") bind(local.text, source);
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
