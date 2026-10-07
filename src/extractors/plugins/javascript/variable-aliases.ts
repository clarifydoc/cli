import type { Node } from "web-tree-sitter";
import type { ImportInfo } from "../../../types/analysis.js";
import type { VariableAliasBinding } from "../../../types/language-plugin.js";
import { buildImportMaps } from "../../shared/call-graph.js";
import { containerLookup } from "./di.js";

/**
 * Extract variable-to-call assignments, in any scope.
 * Returns a map: variable name → import source (resolved through imports).
 *
 * Two binding shapes, both ubiquitous in composable/hook code:
 *   - constructed:   `const prisma = new PrismaClient()` → prisma → "@prisma/client"
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
): Map<string, VariableAliasBinding> {
  const aliases = new Map<string, VariableAliasBinding>();
  const conflicted = new Set<string>();
  const { importMap } = buildImportMaps(imports);

  function bind(name: string, source: string, factory: string) {
    if (conflicted.has(name)) return;
    const prev = aliases.get(name);
    if (prev !== undefined) {
      if (prev.source !== source) {
        aliases.delete(name);
        conflicted.add(name);
      } else if (prev.factory !== factory) {
        // Same module, different factories — the module is still a safe
        // classification target, but the factory is ambiguous.
        prev.factory = undefined;
      }
      return;
    }
    aliases.set(name, { source, factory });
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
        if (!nameNode || !valueNode) continue;
        // `const prisma = new PrismaClient()` binds the receiver just as
        // `const db = drizzle(...)` does — the constructor identifier is the
        // imported name. Without this the single most common ORM idiom left
        // every call on that receiver with an unresolved datastore.
        const isCtor = valueNode.type === "new_expression";
        if (!isCtor && valueNode.type !== "call_expression") continue;
        const fnNode = valueNode.childForFieldName(isCtor ? "constructor" : "function");
        const fnName = fnNode?.text;
        if (!fnName || !importMap.has(fnName)) continue;
        // `const svc = inject(UserService)` is an instance of UserService, not
        // something `@angular/core` exports: binding it to the injector's
        // module made `svc.countUsers()` a call into an external package. The
        // local's type (FunctionInfo.localTypes) is what resolves it.
        if (!isCtor && containerLookup(valueNode)) continue;
        const source = importMap.get(fnName)!;

        if (nameNode.type === "identifier") {
          bind(nameNode.text, source, fnName);
        } else if (nameNode.type === "object_pattern") {
          for (const prop of nameNode.namedChildren) {
            // `{ a }` → shorthand_property_identifier_pattern "a";
            // `{ a: b }` → pair_pattern whose value is the local name.
            if (prop.type === "shorthand_property_identifier_pattern") {
              bind(prop.text, source, fnName);
            } else if (prop.type === "pair_pattern") {
              const local = prop.childForFieldName("value");
              if (local?.type === "identifier") bind(local.text, source, fnName);
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
