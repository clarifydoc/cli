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
 *   - typed member:  `actions: ReturnType<typeof useShopCart>["actions"]` (a prop)
 *     → "actions" → the factory's module, as if destructured from its call
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

  function bind(name: string, source: string, factory: string, member?: string) {
    if (conflicted.has(name)) return;
    const prev = aliases.get(name);
    // A binding from an unimported factory (no source) is the weakest fact: it never
    // displaces or conflicts with one from an imported factory, which replaces it.
    if (prev !== undefined && (prev.source === "") !== (source === "")) {
      if (prev.source === "") aliases.set(name, { source, factory, ...(member ? { member } : {}) });
      return;
    }
    if (prev !== undefined) {
      if (prev.source !== source) {
        aliases.delete(name);
        conflicted.add(name);
      } else if (prev.factory !== factory) {
        // Same module, different factories — the module is still a safe
        // classification target, but the factory is ambiguous.
        prev.factory = undefined;
      }
      // Two bindings of the name to different members: neither is the one called.
      if (prev.member !== member) delete prev.member;
      return;
    }
    aliases.set(name, { source, factory, ...(member ? { member } : {}) });
  }

  // The locals holding a Vue component's props (`const props = defineProps<{ … }>()`, also through
  // `withDefaults(…)`): a typed prop read through them (`props.actions.updateOne()`) is that prop.
  const propsLocals = new Set<string>();
  const findProps = (node: Node): void => {
    if (node.type === "variable_declarator") {
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name");
      if (name?.type === "identifier" && value && /^(?:withDefaults\s*\(\s*)?defineProps\s*[<(]/.test(value.text)) propsLocals.add(name.text);
    }
    for (const child of node.namedChildren) if (child) findProps(child);
  };
  if (/\bdefineProps\b/.test(tree.rootNode.text)) findProps(tree.rootNode);

  function walk(node: Node) {
    // A member typed as what a factory returns — a component prop
    // `actions: ReturnType<typeof useMatches>["actions"]` — is that factory's
    // object as much as `const { actions } = useMatches()` would be: a template's
    // `actions.createOne($event)` is a call into the factory's module.
    if (node.type === "property_signature") {
      const name = node.childForFieldName("name");
      const type = node.childForFieldName("type")?.text.replace(/^:\s*/, "");
      const m = type?.match(/^ReturnType<\s*typeof\s+([A-Za-z_$][\w$]*)\s*>(?:\s*\[\s*["'][\w$]+["']\s*\])?$/);
      // `typeof useMatches` may name a type-only import of the factory: it still names its module.
      if (name?.type === "property_identifier" && m) {
        const source = importMap.get(m[1]!) ?? imports.find((i) => i.specifiers.includes(m[1]!))?.source ?? "";
        bind(name.text, source, m[1]!);
        for (const local of propsLocals) bind(`${local}.${name.text}`, source, m[1]!);
      }
    }
    // Match: const/let/var <pattern> = importedFn()
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const decl of node.children) {
        if (decl.type !== "variable_declarator") continue;
        const nameNode = decl.childForFieldName("name");
        let valueNode = decl.childForFieldName("value");
        if (valueNode?.type === "await_expression") {
          valueNode = valueNode.namedChild(valueNode.namedChildCount - 1) ?? valueNode;
        }
        // `const store = isOwn ? useClubStore() : null`: the one factory a branch calls, the other none.
        if (valueNode?.type === "ternary_expression") {
          const arms = [valueNode.childForFieldName("consequence"), valueNode.childForFieldName("alternative")];
          const empty = (n: Node | null) => !!n && (n.type === "null" || n.type === "undefined" || (n.type === "identifier" && n.text === "undefined"));
          const call = arms.find((n) => n && !empty(n));
          if (call && arms.some(empty) && (call.type === "call_expression" || call.type === "new_expression")) valueNode = call;
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
        if (!fnName) continue;
        // A factory the file calls by a bare name it does not import (`useGarage()` in a Nuxt page,
        // whose framework imports it): the binding keeps the factory with no source, so a member
        // call remembers it (`CallInfo.via`) for the project pass that knows the module.
        if (!importMap.has(fnName)) {
          if (!isCtor && /^[A-Za-z_$][\w$]*$/.test(fnName)) {
            if (nameNode.type === "identifier") bind(nameNode.text, "", fnName);
            else if (nameNode.type === "object_pattern") {
              for (const prop of nameNode.namedChildren) {
                if (prop.type === "shorthand_property_identifier_pattern") bind(prop.text, "", fnName);
                else if (prop.type === "pair_pattern") {
                  const local = prop.childForFieldName("value");
                  if (local?.type === "identifier") bind(local.text, "", fnName, memberKey(prop, local.text));
                }
              }
            }
          }
          continue;
        }
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
              if (local?.type === "identifier") bind(local.text, source, fnName, memberKey(prop, local.text));
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

/** The key a `{ key: local }` pattern destructures, when it renames it. */
function memberKey(pair: Node, local: string): string | undefined {
  const key = pair.childForFieldName("key");
  return key?.type === "property_identifier" && key.text !== local ? key.text : undefined;
}
