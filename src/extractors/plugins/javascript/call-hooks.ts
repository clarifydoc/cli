import { argOriginsOf } from "./arg-origins.js";
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
  // So are the methods of a class expression built in place
  // (`register(new (class implements Runner { run() { … } })())`).
  anonymousScopeTypes: ["arrow_function", "function_expression", "class"],
  runsAtTopLevel: moduleCallback,
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
  argsOf: handedArgs,
  argOriginsOf,
};

/**
 * TypeScript checks a call's argument count against the signature, so the
 * count is recorded there (plain JavaScript passes any number). A spread
 * hides the count; a tagged template passes its parts.
 */
export const typescriptCallHooks: CallExtractionHooks = {
  ...javascriptCallHooks,
  argCountOf(node) {
    const args = node.childForFieldName("arguments");
    if (!args) return node.type === "new_expression" ? 0 : null;
    if (args.type !== "arguments") return null;
    let n = 0;
    for (const a of args.namedChildren) {
      if (a.type === "comment") continue;
      if (a.type === "spread_element") return null;
      n++;
    }
    return n;
  },
  noOverloads: true,
};

/** A function sending an event it is handed: `clientSend`, `broadcastToClub`, `publishEvent`, `notifyAll`. */
const SENDER = /send|emit|broadcast|publish|notify/i;
/** The emitters themselves, whose literal is read where they are called. */
const BARE_SENDER = new Set(["send", "emit", "$emit", "publish", "notify", "broadcast"]);
const EVENT_NAME = /^['"][\w.:-]+['"]$/;

/** Function-like nodes whose parameters an argument may name. */
const FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration", "function_expression", "generator_function", "arrow_function", "method_definition"]);

/**
 * A function call handing something on (`useStore("club", store, api.clubs)`,
 * `useStoreActions(key, api)` where `api` is the enclosing function's own
 * parameter): its arguments, so a project pass can follow a client into the
 * factory that calls it. Only a call of a bare function name, and only when an
 * argument is a member chain off a local or an import, or a parameter of the
 * enclosing function. Any other argument is reported as "" — its position is
 * all that counts.
 */
function handedArgs(node: Node): string[] | null {
  if (node.type !== "call_expression") return null;
  const args = node.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
  if (args.length === 0 || args.length > 8) return null;
  const fn = node.childForFieldName("function");
  // A project wrapper sending the event its caller names (`this.socket.clientSend("match_update", room)`):
  // the literal, quoted as written, for core to fill the wrapper's channel parameter with.
  const leaf = fn?.type === "identifier" ? fn.text : fn?.type === "member_expression" ? fn.childForFieldName("property")?.text ?? "" : "";
  if (SENDER.test(leaf) && !BARE_SENDER.has(leaf) && args[0]!.type === "string" && EVENT_NAME.test(args[0]!.text)) {
    return args.map((a, i) => (i === 0 ? a.text : ""));
  }
  if (fn?.type !== "identifier") return null;
  let params: Set<string> | null = null;
  const param = (name: string) => (params ??= enclosingParams(node)).has(name);
  // A chain the function holds itself (`api.clubs` off a local): one rooted in
  // its own parameter (`req.params.id`) is its caller's to say.
  const chain = (a: Node) => a.type === "member_expression" && /^[\w$]+(?:\.[\w$]+)+$/.test(a.text) && !a.text.startsWith("this.") && !param(a.text.slice(0, a.text.indexOf(".")));
  const isParam = (a: Node) => a.type === "identifier" && param(a.text);
  if (!args.some((a) => chain(a) || isParam(a))) return null;
  return args.map((a) => (chain(a) || isParam(a) ? a.text : ""));
}

/** Names the innermost enclosing function binds as parameters (`(key, api, { page })`). */
function enclosingParams(node: Node): Set<string> {
  const out = new Set<string>();
  let fn: Node | null = node.parent;
  while (fn && !FUNCTION_NODES.has(fn.type)) fn = fn.parent;
  if (!fn) return out;
  const single = fn.childForFieldName("parameter");
  if (single?.type === "identifier") out.add(single.text);
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    const pattern = p?.childForFieldName("pattern") ?? p;
    const name = pattern?.type === "assignment_pattern" ? pattern.childForFieldName("left") : pattern;
    if (name?.type === "identifier") out.add(name.text);
  }
  return out;
}

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

/**
 * An anonymous callback a module's top level hands to a plain function call —
 * `computed(() => …)`, `onMounted(() => …)`, `useQuery({ queryFn: async () => … })`
 * — runs as part of the module (a component's setup), so its calls are the
 * module's. A handler handed to a method (`app.get("/x", (req, res) => …)`) or
 * to a test runner (`it("…", () => …)`) is registered for later, and a function
 * bound to a name is its own.
 */
function moduleCallback(node: Node): boolean {
  if (node.type !== "arrow_function" && node.type !== "function_expression") return false;
  let at: Node | null = node.parent;
  // `useQuery({ queryFn: … })`, `[{ action: … }]`: through the option object and its arrays.
  while (at && (at.type === "pair" || at.type === "object" || at.type === "array")) at = at.parent;
  if (at?.type !== "arguments") return false;
  const call = at.parent?.type === "call_expression" ? at.parent : null;
  const callee = call?.childForFieldName("function");
  // `router.get("/x", asyncHandler(async (req, res) => …))`: a wrapper handed on is registered with it.
  return callee?.type === "identifier" && !TEST_REGISTRATION.has(callee.text) && call!.parent?.type !== "arguments";
}

/** A test runner's registrations: their callbacks run when the runner says, each its own test. */
const TEST_REGISTRATION: ReadonlySet<string> = new Set([
  "describe", "it", "test", "suite", "context", "beforeEach", "afterEach", "beforeAll", "afterAll", "before", "after", "fdescribe", "xdescribe", "fit", "xit",
]);
