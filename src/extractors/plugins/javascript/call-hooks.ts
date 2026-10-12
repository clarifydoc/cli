import type { Node } from "web-tree-sitter";
import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { receiverTypeOfCall } from "./di.js";

/** Vue 3 <script setup> compiler macros — auto-imported, not in imports array */
const VUE_COMPILER_MACROS = new Set([
  "defineProps", "defineEmits", "defineExpose", "defineOptions",
  "defineModel", "defineSlots", "withDefaults", "emit",
]);

/** Shared by the typescript and javascript metas. */
export const javascriptCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["call_expression", "new_expression"]),
  keyOf: dispatchKeyOf,
  nestedScopeTypes: [
    "arrow_function",
    "function_expression",
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "class",
  ],
  // Inline handlers/callbacks are anonymous expressions — their calls belong
  // to the enclosing function (see CallExtractionHooks.anonymousScopeTypes).
  anonymousScopeTypes: ["arrow_function", "function_expression"],
  callbackArgNodeTypes: ["call_expression"],
  // A name the function binds itself is a value when passed as an argument,
  // not a callback reference (see CallExtractionHooks.bindingSites).
  bindingSites: {
    function_declaration: ["parameters"],
    generator_function_declaration: ["parameters"],
    function_expression: ["parameters"],
    generator_function: ["parameters"],
    method_definition: ["parameters"],
    arrow_function: ["parameter", "parameters"],
    variable_declarator: ["name"],
    assignment_expression: ["left"],
    for_in_statement: ["left"],
    catch_clause: ["parameter"],
  },
  bindingPatterns: {
    formal_parameters: ["*"],
    required_parameter: ["pattern"],
    optional_parameter: ["pattern"],
    object_pattern: ["*"],
    array_pattern: ["*"],
    rest_pattern: ["*"],
    pair_pattern: ["value"],
    assignment_pattern: ["left"],
    object_assignment_pattern: ["left"],
  },

  // Generic name resolution covers JS/TS; the extra call shape is JSX:
  // <ComponentName ... /> counts as using ComponentName.
  collectExtraCalls(node, addResult) {
    if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
      const nameNode = node.childForFieldName("name") ?? node.child(1);
      if (nameNode && /^[A-Z]/.test(nameNode.text)) {
        addResult(nameNode.text, nameNode);
      }
    }
  },

  classifyAutoImported(callName) {
    return VUE_COMPILER_MACROS.has(callName) ? { target: "vue" } : null;
  },

  // A container lookup or a cast chained straight into the call
  // (`this.moduleRef.get(ReportService).buildReport()`,
  // `container.get<IUserRepo>(TYPES.UserRepo).fetchUserById(1)`,
  // `(this.gadget as GadgetService).buffGadget()`) names its receiver's type.
  receiverTypeOf: receiverTypeOfCall,
};

/**
 * `store.dispatch('contacts/get')`, `this.$store.dispatch("x")`, `dispatch('x')`:
 * Vuex routes an action by its name string, so the string is the call's key.
 * Only a literal first argument counts; `dispatch(fetchMovies())` (Redux) is a
 * call of the thunk creator and resolves by name like any other call.
 */
function dispatchKeyOf(node: Node): string | null {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function");
  const leaf = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : fn?.type === "identifier" ? fn.text : null;
  if (leaf !== "dispatch") return null;
  const first = node.childForFieldName("arguments")?.namedChildren[0];
  if (!first) return null;
  if (first.type === "string") return first.text.slice(1, -1) || null;
  if (first.type === "template_string" && !first.namedChildren.some((c) => c.type === "template_substitution")) return first.text.slice(1, -1) || null;
  return null;
}
