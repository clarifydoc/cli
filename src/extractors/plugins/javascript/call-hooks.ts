import { argOriginsOf } from "./arg-origins.js";
import { boundAtSite } from "./block-scope.js";
import type { Node } from "web-tree-sitter";
import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { receiverTypeOfCall } from "./di.js";
import { signalReceiverTypeOfCall } from "./signal-receivers.js";
import { boundHandler, boundThroughWrapper } from "./wrapped-functions.js";
import { dispatchMapCallee, dispatchMapEntries, dispatchMapMember, importedMapMember, recordCallee } from "./dispatch-maps.js";
import { enclosingFunctionNode, FUNCTION_NODE, paramNames } from "../../shared/node-helpers.js";
import { genericResolveCallName } from "../../shared/call-graph.js";
import { TEST_REGISTRATION } from "./test-cases.js";
import { dispatchKeyOfArgs } from "./vuex.js";
import { recordIndexOrigin } from "./dispatch-maps.js";
import { loadedMemberCall } from "./loaded-members.js";
import { requiredSource } from "./imports-exports.js";
import { arrayMapEntries, memberAssignment, namesFunction } from "./member-values.js";
import { heldFunction } from "./held-functions.js";
import { contractFunction } from "./contract-handlers.js";
import { libraryObjectMembers } from "./library-callbacks.js";

/** Vue 3 <script setup> compiler macros — auto-imported, not in imports array */
const VUE_COMPILER_MACROS = new Set([
  "defineProps", "defineEmits", "defineExpose", "defineOptions",
  "defineModel", "defineSlots", "withDefaults", "emit",
]);

/** Shared by the typescript and javascript metas. */
/** A plain or dotted name (`saveClub`, `clubs.loadLatest`, `this.save`), never `undefined`/`null`-like literals. */
const JSX_PASSED_NAME = /^(?!undefined$|null$|true$|false$)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * The names a returned object or array hands back, with the key a caller destructures each by:
 * `{ save, latest: loadLatest }` → save/`save`, loadLatest/`latest`; `[rows, refresh]` → refresh/`[1]`.
 */
function returnedNames(expr: Node | undefined): Array<{ value: Node; key: string }> {
  while (expr && (expr.type === "parenthesized_expression" || expr.type === "as_expression" || expr.type === "satisfies_expression")) {
    expr = expr.namedChildren[0];
  }
  if (!expr) return [];
  const named = (n: Node | null | undefined): n is Node =>
    !!n && (n.type === "identifier" || n.type === "member_expression") && JSX_PASSED_NAME.test(n.text);
  if (expr.type === "object") {
    return expr.namedChildren.flatMap((p) => {
      if (p.type === "shorthand_property_identifier") return [{ value: p, key: p.text }];
      const key = p.type === "pair" ? p.childForFieldName("key") : null;
      const value = p.type === "pair" ? p.childForFieldName("value") : null;
      return key && /^(?:property_identifier|string)$/.test(key.type) && named(value)
        ? [{ value, key: key.text.replace(/^["']|["']$/g, "") }] : [];
    });
  }
  if (expr.type === "array") {
    return expr.namedChildren.flatMap((el, i) => (named(el) ? [{ value: el, key: `[${i}]` }] : []));
  }
  return [];
}

export const javascriptCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["call_expression", "new_expression"]),
  keyOf: dispatchKeyOf,
  nestedScopeTypes: [
    "arrow_function",
    "function_expression",
    "generator_function",
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "class",
  ],
  // Inline handlers/callbacks are anonymous expressions — their calls belong
  // to the enclosing function (see CallExtractionHooks.anonymousScopeTypes).
  // So are the methods of a class expression built in place
  // (`register(new (class implements Runner { run() { … } })())`).
  anonymousScopeTypes: ["arrow_function", "function_expression", "generator_function", "class"],
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

  // Generic name resolution covers JS/TS; the extra call shapes are JSX:
  // <ComponentName ... /> counts as using ComponentName, and an attribute whose
  // value names a function (`onClick={saveClub}`, `renderItem={CarTile}`,
  // `onRefresh={clubs.loadLatest}`) hands that function on.
  collectExtraCalls(node, addResult) {
    if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
      const nameNode = node.childForFieldName("name") ?? node.child(1);
      if (nameNode && /^[A-Z]/.test(nameNode.text)) {
        addResult(nameNode.text, nameNode);
      }
    } else if (node.type === "jsx_attribute") {
      const value = node.namedChildren.find((c) => c.type === "jsx_expression")?.namedChildren[0];
      if (value && (value.type === "identifier" || value.type === "member_expression") && JSX_PASSED_NAME.test(value.text)) {
        addResult(value.text, value, "attribute");
      }
    } else if (node.type === "return_statement") {
      // What a hook or factory hands back: `return { save, latest: loadLatest }`, `return [rows, refresh]`.
      for (const { value, key } of returnedNames(node.namedChildren[0])) addResult(value.text, value, "return", key);
    } else if (node.type === "variable_declarator") {
      // A dispatch map: `const ACTIONS = { save: saveClub }` holds `saveClub` under `ACTIONS.save`.
      const map = dispatchMapEntries(node);
      for (const { value, key } of map?.entries ?? []) addResult(value.text, value, "property", `${map!.holder}.${key}`);
      // The objects of a declared array: `const items = [{ run: sellPlayer }]` holds `sellPlayer` under `items[].run`.
      const list = arrayMapEntries(node);
      for (const { name, node: value, key } of list?.entries ?? []) addResult(name, value, "property", `${list!.holder}[].${key}`);
      // A library object: `const table = useVueTable({ onPaginationChange: … })` holds the callback under each method running it (`table.nextPage`).
      const lib = libraryObjectMembers(node, heldFunction, namesFunction);
      for (const { name, node: value, method, option } of lib?.members ?? []) addResult(name, value, "property", `${lib!.holder}.${method}`, { libraryOption: option });
    } else if (node.type === "assignment_expression") {
      // A function value assigned to a module object's member at run time (`dialog.callback = deleteClubs`).
      for (const { name, node: value, holder } of memberAssignment(node)) addResult(name, value, "property", holder);
    }
  },

  // A callback, or a handler an RPC server is given in place (`createServer(ClubService, { getClub() {…} })`): a function of its own.
  heldFunction: (node) => heldFunction(node) ?? contractFunction(node),

  // `ACTIONS[kind]()`, `ACTIONS["save"]()` on a dispatch map the file declares.
  // A call on a module loaded in place is the module's own member, read where the body is scanned; a
  // `require("./x")` naming its module is an import fact (the member call's receiver, a binding's initializer), never a call.
  // `stores[props.kind].actions.createOne()` on a record of call results: `stores[].actions.createOne`, fanned out by the linker.
  // `this['clubs/update']()` where `mapActions(['clubs/update'])` bound that name: `this.clubs/update`, keyed by the action.
  resolveCallName: (node) => {
    if (loadedMemberCall(node) || requiredSource(node)) return null;
    let callee = node.childForFieldName("function");
    // `await pick<Club>(id)` mis-nests as call(function: await_expression(pick), type_arguments, arguments):
    // the generic makes the await bind to the callee alone. The call is still `pick`.
    const awaitedGeneric = callee?.type === "await_expression";
    if (awaitedGeneric) {
      callee = callee!.namedChild(callee!.namedChildCount - 1);
      if (!callee) return null;
    }
    const record = callee?.type === "member_expression" && callee.text.includes("[") ? recordCallee(callee) : null;
    return record ?? genericResolveCallName(node, {
      ...(awaitedGeneric ? { calleeOverride: callee } : {}),
      extraCallee: (c) => dispatchMapCallee(c) ?? mappedActionCallee(c),
    });
  },

  // `ACTIONS.send(club)` on a map holding `send`: the map's own key, not a noise-named method.
  statedMember: (node, name) => dispatchMapMember(name, node),
  importedMapMember: (node, name) => importedMapMember(name, node),

  // `addEventListener("resize", this.onResize)`: the instance's own method, handed on — also bound first
  // (`saved.subscribe(this.reload.bind(this))`, `setTimeout(refresh.bind(null, id))`).
  passedArguments(call) {
    if (call.type !== "call_expression") return [];
    const args = call.childForFieldName("arguments");
    const out: Array<{ name: string; node: Node; ownMember?: boolean }> = [];
    for (const a of args?.namedChildren ?? []) {
      if (a.type === "member_expression" && /^this\.[A-Za-z_$][\w$]*$/.test(a.text)) out.push({ name: a.text, node: a, ownMember: true });
      const fn = a.type === "call_expression" ? a.childForFieldName("function") : null;
      const bound = fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "bind" ? fn.childForFieldName("object") : null;
      if (bound?.type === "member_expression" && /^this\.[A-Za-z_$][\w$]*$/.test(bound.text)) out.push({ name: bound.text, node: bound, ownMember: true });
      else if (bound?.type === "identifier") out.push({ name: bound.text, node: bound });
    }
    return out;
  },

  destructuredFromCall(node) {
    if (node.type !== "variable_declarator") return null;
    const pattern = node.childForFieldName("name");
    let value = node.childForFieldName("value");
    if (value?.type === "await_expression") value = value.namedChildren[0] ?? null;
    if (!pattern || value?.type !== "call_expression") return null;
    if (pattern.type === "object_pattern") {
      return pattern.namedChildren.flatMap((p) =>
        p.type === "shorthand_property_identifier_pattern" ? [p.text]
          : p.type === "pair_pattern" && p.childForFieldName("value")?.type === "identifier" ? [p.childForFieldName("value")!.text] : []);
    }
    if (pattern.type === "array_pattern") return pattern.namedChildren.filter((p) => p.type === "identifier").map((p) => p.text);
    return null;
  },

  classifyAutoImported(callName) {
    return VUE_COMPILER_MACROS.has(callName) ? { target: "vue" } : null;
  },

  // A tRPC client's `trpc.club.byId.query(…)` / `.mutate(…)`: a request to the procedure, not a database query.
  isApiCallShape(callName, imports) {
    if (!TRPC_CLIENT_CALL_RE.test(callName)) return false;
    return /trpc/i.test(callName.split(".")[0]!) || imports.some((i) => /trpc/i.test(i.source));
  },

  // A container lookup or a cast chained straight into the call
  // (`this.moduleRef.get(ReportService).buildReport()`,
  // `container.get<IUserRepo>(TYPES.UserRepo).fetchUserById(1)`,
  // `(this.gadget as GadgetService).buffGadget()`) names its receiver's type.
  receiverTypeOf: (node) => receiverTypeOfCall(node) ?? signalReceiverTypeOfCall(node),
  boundAt: boundAtSite,
  argsOf: handedArgs,
  indexOriginOf: (node, name) => (name.includes("[]") ? recordIndexOrigin(node.childForFieldName("function") ?? node) : null),
  argOriginsOf,
};

/** `<client>.<router>.<procedure>.query` / `.mutate`, never on `this` (the extractor's own rule for an api-call row). */
const TRPC_CLIENT_CALL_RE = /^(?!this\.)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}\.(?:query|mutate)$/;

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
  // `store.dispatch(ACTIONS.FETCH_CLUBS)`, `dispatch(LOAD_CLUBS)` naming the action by a constant the file does not
  // declare: the name as written, for the Vuex pass to read in the module that does.
  if (leaf === "dispatch" && args[0]!.type !== "string" && /^(?:[A-Za-z_$][\w$]*(?:\.[\w$]+)+|[A-Z][A-Z0-9_]*)$/.test(args[0]!.text) && !/^(?:this|props)\b/.test(args[0]!.text) && dispatchKeyOf(node) === null) {
    const head = args[0]!.text.split(".")[0]!;
    if (!enclosingParams(node).has(head)) return args.map((a, i) => (i === 0 ? a.text : ""));
  }
  if (fn?.type !== "identifier") return null;
  let params: Set<string> | null = null;
  const param = (name: string) => (params ??= enclosingParams(node)).has(name);
  // A chain the function holds itself (`api.clubs` off a local): one rooted in
  // its own parameter (`req.params.id`) is its caller's to say.
  const chain = (a: Node) => a.type === "member_expression" && /^[\w$]+(?:\.[\w$]+)+$/.test(a.text) && !a.text.startsWith("this.") && !param(a.text.slice(0, a.text.indexOf(".")));
  const isParam = (a: Node) => a.type === "identifier" && param(a.text);
  // A hook / composable (`useTableSort(sortBy, resetPage)`): what it is handed is what its body calls by the
  // parameter's name — a function or object named by an identifier, or a callback arrow that only calls one.
  if (HOOK_NAME.test(fn.text)) {
    const handed = args.map((a) => (chain(a) || isParam(a) || a.type === "identifier" && a.text !== "undefined" ? a.text : callbackTarget(a)));
    return handed;
  }
  if (!args.some((a) => chain(a) || isParam(a))) return null;
  return args.map((a) => (chain(a) || isParam(a) ? a.text : ""));
}

/** The name a hook is called by: `useX` (Vue composables, React hooks). */
const HOOK_NAME = /^use[A-Z][\w$]*$/;

/** `x => emit2(x)` / `() => save(club)`: `=>emit2` — a callback arrow whose body is one call of a plain name or member chain. */
function callbackTarget(arg: Node): string {
  if (arg.type !== "arrow_function") return "";
  let body = arg.childForFieldName("body");
  if (body?.type === "statement_block" && body.namedChildCount === 1) {
    const only = body.namedChild(0);
    body = only?.type === "expression_statement" ? only.namedChild(0) : only?.type === "return_statement" ? only.namedChild(0) : null;
  }
  if (body?.type === "await_expression") body = body.namedChild(0);
  const callee = body?.type === "call_expression" ? body.childForFieldName("function") : null;
  return callee && /^[\w$]+(?:\.[\w$]+)*$/.test(callee.text) ? `=>${callee.text}` : "";
}

/** Names the innermost enclosing function binds as parameters (`(key, api, { page })`). */
function enclosingParams(node: Node): Set<string> {
  const fn = enclosingFunctionNode(node);
  return new Set(fn ? paramNames(fn).filter(Boolean) : []);
}

/**
 * `store.dispatch('contacts/get')`, `this.$store.dispatch("x")`, `dispatch('x')`:
 * Vuex routes an action by its name string, so the string is the call's key.
 * Only a literal first argument counts; `dispatch(fetchTrophies())` (Redux) is a
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
  // `this['clubs/update'](…)` where it spread `...mapActions(['clubs/update'])`.
  if (fn?.type === "subscript_expression") {
    const name = mappedActionCallee(fn);
    return name ? mappedActions(node).get(name.slice("this.".length)) ?? null : null;
  }
  const leaf = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : fn?.type === "identifier" ? fn.text : null;
  if (leaf === "queue" || leaf === "queueAll" || leaf === "emit") return jobOrEventKey(node, leaf);
  if (leaf !== "dispatch") return null;
  return dispatchKeyOfArgs((node.childForFieldName("arguments")?.namedChildren ?? []).filter((a): a is Node => !!a && a.type !== "comment"));
}

/** `this['clubs/update']` naming a method `mapActions` bound (`mapActions(['clubs/update'])`): `this.clubs/update`. */
function mappedActionCallee(callee: Node): string | null {
  if (callee.type !== "subscript_expression" || callee.childForFieldName("object")?.type !== "this") return null;
  const index = callee.childForFieldName("index");
  if (index?.type !== "string" || index.text.length <= 2) return null;
  const name = index.text.slice(1, -1);
  return mappedActions(callee).has(name) ? `this.${name}` : null;
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
  if (leaf === "queue") {
    const name = jobName(first);
    return name ? `job:${name}` : null;
  }
  // `queueAll([...])`, `queueAll(ids.map((id) => ({ name: JobName.X, … })))`, or a list the
  // function builds (`const jobs = [{ name: … }]; jobs.push({ name: … })`): every job it names.
  const names = [...new Set(jobNamesIn(first, node, 0))];
  return names.length > 0 ? names.map((n) => `job:${n}`).join(JOB_KEY_SEPARATOR) : null;
}

/** Several job keys in one `CallInfo.key`, as `queueAll` enqueues several jobs. */
export const JOB_KEY_SEPARATOR = "|";

/** `{ name: JobName.X, … }` → `JobName.X` (a string literal unquoted). */
function jobName(job: Node | null | undefined): string | null {
  while (job?.type === "parenthesized_expression") job = job.namedChildren[0];
  if (job?.type !== "object") return null;
  for (const pair of job.namedChildren) {
    if (pair.type !== "pair" || pair.childForFieldName("key")?.text !== "name") continue;
    const value = pair.childForFieldName("value");
    if (value?.type === "string") return value.text.slice(1, -1);
    if (value?.type === "member_expression" && /^[\w$]+\.[\w$]+$/.test(value.text)) return value.text;
  }
  return null;
}

/** The job names a list expression holds, following a local list to where the function builds it. */
function jobNamesIn(expr: Node | null | undefined, at: Node, depth: number): string[] {
  if (!expr || depth > 3) return [];
  const direct = jobName(expr);
  if (direct) return [direct];
  if (expr.type === "array") {
    return expr.namedChildren.flatMap((el) => (el.type === "spread_element" ? jobNamesIn(el.namedChildren[0], at, depth + 1) : jobName(el) ? [jobName(el)!] : []));
  }
  // `items.map((x) => ({ name: … }))`: what the callback returns.
  if (expr.type === "call_expression") {
    const fn = expr.childForFieldName("function");
    if (fn?.type !== "member_expression" || !/^(?:map|flatMap)$/.test(fn.childForFieldName("property")?.text ?? "")) return [];
    const cb = expr.childForFieldName("arguments")?.namedChildren[0];
    if (cb?.type !== "arrow_function") return [];
    const body = cb.childForFieldName("body");
    if (body?.type === "statement_block") return body.descendantsOfType("return_statement").flatMap((r) => jobNamesIn(r?.namedChildren[0], at, depth + 1));
    return jobNamesIn(body, at, depth + 1);
  }
  if (expr.type !== "identifier") return [];
  // A local of the enclosing function: its initializer and every `push` onto it.
  let scope: Node | null = at.parent;
  while (scope && !/function|method_definition|arrow_function/.test(scope.type)) scope = scope.parent;
  if (!scope) return [];
  const name = expr.text;
  const out: string[] = [];
  for (const d of scope.descendantsOfType("variable_declarator")) {
    if (d?.childForFieldName("name")?.text === name) out.push(...jobNamesIn(d.childForFieldName("value"), at, depth + 1));
  }
  for (const c of scope.descendantsOfType("call_expression")) {
    const fn = c?.childForFieldName("function");
    if (fn?.type !== "member_expression" || fn.childForFieldName("object")?.text !== name || fn.childForFieldName("property")?.text !== "push") continue;
    for (const arg of c!.childForFieldName("arguments")?.namedChildren ?? []) out.push(...(arg.type === "spread_element" ? jobNamesIn(arg.namedChildren[0], at, depth + 1) : jobName(arg) ? [jobName(arg)!] : []));
  }
  return out;
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
  // `export const Tyre = observer(() => …)`: the binding's own function, not the module's.
  if (boundThroughWrapper(node) || boundHandler(node)) return false;
  let at: Node | null = node.parent;
  // `useQuery({ queryFn: … })`, `[{ action: … }]`: through the option object and its arrays.
  while (at && (at.type === "pair" || at.type === "object" || at.type === "array")) at = at.parent;
  if (at?.type !== "arguments") return false;
  const call = at.parent?.type === "call_expression" ? at.parent : null;
  const callee = call?.childForFieldName("function");
  // `router.get("/x", asyncHandler(async (req, res) => …))`: a wrapper handed on is registered with it.
  return callee?.type === "identifier" && !TEST_REGISTRATION.has(callee.text) && call!.parent?.type !== "arguments";
}

