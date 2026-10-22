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
  // `this.sendMessage(…)` where the component spread `...mapActions('chat', ['sendMessage'])`.
  if (fn?.type === "member_expression" && fn.childForFieldName("object")?.type === "this") {
    const prop = fn.childForFieldName("property")?.text;
    return prop ? (mappedActions(node).get(prop) ?? null) : null;
  }
  const leaf = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : fn?.type === "identifier" ? fn.text : null;
  if (leaf === "queue" || leaf === "queueAll" || leaf === "emit") return jobOrEventKey(node, leaf);
  if (leaf !== "dispatch") return null;
  const first = node.childForFieldName("arguments")?.namedChildren[0];
  if (!first) return null;
  if (first.type === "string") return first.text.slice(1, -1) || null;
  if (first.type === "template_string" && !first.namedChildren.some((c) => c.type === "template_substitution")) return first.text.slice(1, -1) || null;
  return null;
}

/**
 * A job enqueued or an event emitted by name, for the job/event dispatch
 * resolver (job-events.ts): `jobRepository.queue({ name: JobName.Thumbnail, data })`
 * → `job:JobName.Thumbnail` (`queueAll([…])` by its first job), and
 * `eventRepository.emit('AlbumUpdate', …)` → `event:AlbumUpdate`. A member
 * receiver only — a bare `emit(…)` is a component's own.
 */
function jobOrEventKey(node: Node, leaf: string): string | null {
  if (node.childForFieldName("function")?.type !== "member_expression") return null;
  const first = node.childForFieldName("arguments")?.namedChildren[0];
  if (!first) return null;
  if (leaf === "emit") return first.type === "string" && first.text.length > 2 ? `event:${first.text.slice(1, -1)}` : null;
  const job = leaf === "queueAll" ? (first.type === "array" ? first.namedChildren[0] : null) : first;
  if (job?.type !== "object") return null;
  for (const pair of job.namedChildren) {
    if (pair.type !== "pair" || pair.childForFieldName("key")?.text !== "name") continue;
    const value = pair.childForFieldName("value");
    if (value?.type === "string") return `job:${value.text.slice(1, -1)}`;
    if (value?.type === "member_expression" && /^[\w$]+\.[\w$]+$/.test(value.text)) return `job:${value.text}`;
  }
  return null;
}

/**
 * The component methods `mapActions` binds in this file, by local name → the
 * action key a `dispatch` would name: `mapActions('chat', ['send'])` →
 * `send → chat/send`, `mapActions('chat', { post: 'send' })` → `post → chat/send`,
 * `mapActions(['chat/send'])` → `chat/send`. Literal arguments only.
 */
let actionsTree: Node["tree"] | null = null;
let actions = new Map<string, string>();

function mappedActions(node: Node): Map<string, string> {
  if (node.tree === actionsTree) return actions;
  actionsTree = node.tree;
  actions = new Map();
  if (!node.tree.rootNode.text.includes("mapActions")) return actions;
  const literal = (n: Node | undefined): string | null =>
    n?.type === "string" ? n.text.slice(1, -1) : n?.type === "template_string" && n.namedChildren.length === 0 ? n.text.slice(1, -1) : null;
  for (const call of node.tree.rootNode.descendantsOfType("call_expression")) {
    if (call.childForFieldName("function")?.text !== "mapActions") continue;
    const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
    const ns = args.length > 1 ? literal(args[0]) : null;
    if (args.length > 1 && ns === null) continue;
    const map = args[args.length - 1];
    const keyed = (act: string) => (ns ? `${ns}/${act}` : act);
    if (map?.type === "array") {
      for (const el of map.namedChildren) {
        const act = literal(el);
        if (act) actions.set(act, keyed(act));
      }
    } else if (map?.type === "object") {
      for (const pair of map.namedChildren) {
        if (pair.type !== "pair") continue;
        const local = pair.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "");
        const act = literal(pair.childForFieldName("value") ?? undefined);
        if (local && act) actions.set(local, keyed(act));
      }
    }
  }
  return actions;
}
