import type { Node, Tree } from "web-tree-sitter";
import type { FileAnalysis, StoreWatch, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";
import { sameCell } from "../../../core/reactive-triggers.js";
import { VUEX_FACTORY } from "./store-reads.js";
import { NUXT_CONFIG } from "./nuxt-auto-imports.js";
import { stateParamReads } from "./vuex-state-reads.js";
import { piniaStoreOf, type PiniaStore } from "./functions-classes.js";
import { FALSY, MUTATORS, argumentsOf, getterOf, importSources, innermost, reactiveCellsOf, readPath } from "./reactive-cells.js";
import { homeOf, type Files } from "./prop-flows.js";


/**
 * Store state watched in one file and written in another (`FileAnalysis.storeWatch`):
 *
 *   - a component's `watch(() => store.filters.league, …)`, a `storeToRefs` ref or a computed over store state is a
 *     watcher (`store-reads.ts`), naming the store factory as written;
 *   - a Pinia store file's actions write its state — option store `this.filters.league = x`, `this.picked.push(c)`,
 *     `this.$patch({ filters })`, setup store `filters.value = x` on a ref it returns — each write named by the
 *     function it sits in, on the store class the binding returns (`ClubStore`).
 *
 * `JsStoreWatchResolver` joins them by store — the file and class the factory resolves to, never the state's name: an
 * action of another store writing a `filters` of its own, and a component's own ref of that name, run nothing here.
 */
export function storeWatch(tree: Tree, sourceText: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): StoreWatch | null {
  const out: StoreWatch = {};
  const facts = reactiveCellsOf(tree);
  if (facts.storeTriggers?.length) {
    const declared = new Set(functions.map((f) => f.name));
    const watchers: NonNullable<StoreWatch["watchers"]> = [];
    for (const t of facts.storeTriggers) {
      const name = (t.callback ? facts.held.get(t.callback.id) ?? facts.optionNames.get(t.callback.id) : undefined) ?? (t.callee && declared.has(t.callee) ? t.callee : undefined);
      if (!name || !declared.has(name)) continue;
      const line = t.at.startPosition.row + 1;
      if (!watchers.some((w) => w.function === name && w.line === line)) watchers.push({ reads: t.reads, function: name, line, ...(t.immediate ? { immediate: true } : {}), ...(t.truthyOnly ? { truthyOnly: true } : {}) });
    }
    if (watchers.length > 0) out.watchers = watchers;
  }
  const derived: Derived[] = [];
  const writes: Write[] = sourceText.includes("defineStore") ? storeWrites(tree, functions, derived) : [];
  // A composable keeps its state in refs it returns, as a setup store does.
  if (/\buse[A-Z][\w$]*/.test(sourceText) && /\b(?:ref|reactive|shallowRef|shallowReactive)\s*\(/.test(sourceText)) composableWrites(tree, functions, writes, derived);
  // What a component writes in a store it holds, by the factory it asked for.
  for (const w of facts.storeWrites ?? []) {
    // A Vuex store's state changes through its mutations (`stateWrites`), never through a write here.
    if (w.factory === VUEX_FACTORY) continue;
    const line = w.line ?? w.node!.startPosition.row + 1;
    // A statement the template runs is the component's own, which its `<setup>` stands for.
    const fn = w.template ? "<setup>" : innermost(functions, line);
    if (!fn || writes.some((o) => o.viaFactory && o.store === w.factory && o.path === w.path && o.function === fn && o.line === line)) continue;
    writes.push({ store: w.factory, path: w.path, function: fn, line, spelling: w.path.split(".").find((p) => p !== "[]") ?? "", viaFactory: true, ...(w.falsy ? { falsy: true } : {}) });
  }
  if (writes.length > 0) out.writes = writes;
  if (derived.length > 0) out.derived = derived;
  const stateWrites = /mutations/i.test(sourceText) ? vuexStateWrites(tree, functions) : [];
  if (stateWrites.length > 0) out.stateWrites = stateWrites;
  const getterReads = /getters/i.test(sourceText) ? vuexGetterReads(tree) : [];
  if (getterReads.length > 0) out.getterReads = getterReads;
  return out.watchers || out.writes || out.stateWrites || out.derived || out.getterReads ? out : null;
}

type StateWrite = NonNullable<StoreWatch["stateWrites"]>[number];

/**
 * The state a Vuex mutation writes, by the mutation function: in an object that is a `mutations` table — the member of a
 * module or store definition, or a `const xMutations = {…}` another table spreads in — the function's first parameter is
 * the module's state, and `state.list = v`, `state.list.push(c)`, `state.byId.set(k, c)`, `Object.assign(state.filters, p)`,
 * `Vue.set(state.byId, k, c)` write below it (`Object.assign(state, p)` and a computed key write what the file cannot name: `""`).
 * Paths are relative to the module; `vuex-state.ts` prefixes the namespace the root store registers the module under.
 */
export function vuexStateWrites(tree: Tree, functions: readonly Fn[]): StateWrite[] {
  const out: StateWrite[] = [];
  const tables: Node[] = [];
  for (const p of tree.rootNode.descendantsOfType("pair")) {
    const value = p?.childForFieldName("value");
    if (p && value?.type === "object" && /^['"]?mutations['"]?$/.test(p.childForFieldName("key")?.text ?? "")) tables.push(value);
  }
  for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
    const value = d?.childForFieldName("value");
    if (d && value?.type === "object" && /(?:^|[a-z])[mM]utations$/.test(d.childForFieldName("name")?.text ?? "")) tables.push(value);
  }
  // Vue 2.7 exports `set` and `del`: a bare call counts only when the file imports it from Vue.
  const vueNames = new Map<string, string>();
  for (const [name, src] of importSources(tree.rootNode)) if (src === "vue" && (name === "set" || name === "del")) vueNames.set(name, src);
  const seen = new Set<number>();
  for (const table of tables) {
    if (seen.has(table.id)) continue;
    seen.add(table.id);
    for (const m of table.namedChildren) {
      const fn = m?.type === "method_definition" ? m : m?.type === "pair" && m.childForFieldName("value") && /^(?:arrow_function|function_expression|function)$/.test(m.childForFieldName("value")!.type) ? m.childForFieldName("value")! : null;
      const body = fn?.childForFieldName("body");
      if (!fn || !body) continue;
      let param = fn.childForFieldName("parameters")?.namedChildren[0] ?? fn.childForFieldName("parameter");
      if (param?.type === "required_parameter" || param?.type === "optional_parameter") param = param.childForFieldName("pattern");
      // A Vuex mutation takes the module's state first, named `state` by every convention.
      if (param?.type !== "identifier" || !/^_?state$/.test(param.text)) continue;
      const name = param.text;
      const rootOf: RootTest = (n) => (n.type === "identifier" && n.text === name ? name : null);
      const emit = (node: Node, path: readonly string[], falsy: boolean): void => {
        const line = node.startPosition.row + 1;
        const owner = innermost(functions, line);
        if (!owner) return;
        // An element or a computed member of the state itself names no member the file can state.
        const joined = path[0] === "[]" ? "" : path.join(".");
        if (out.some((w) => w.path === joined && w.function === owner && w.line === line)) return;
        out.push({ path: joined, function: owner, line, spelling: path.find((x) => x !== "[]") ?? "", ...(falsy ? { falsy: true } : {}) });
      };
      writesIn(body, rootOf, emit, () => {});
      // `Object.assign(state.filters, p)` and `Vue.set(state.byId, k, c)` write members of the target, as a mutator does.
      walk(body, (n) => {
        if (n.type !== "call_expression") return;
        const callee = n.childForFieldName("function")?.text ?? "";
        if (!/^(?:Object\.assign|Vue\.set|Vue\.delete|Vue\.\$set|\$set)$/.test(callee) && !((callee === "set" || callee === "del") && vueNames.get(callee) !== undefined)) return;
        const t = targetOf(argumentsOf(n)[0] ?? null, rootOf, true);
        if (!t) return;
        // `Object.assign(state, p)`: every member of the module's state may change.
        emit(n, t.path.length === 1 && t.path[0] === "[]" ? [] : t.path, false);
      });
    }
  }
  return out;
}

/** The state each getter of a `getters` table (a module's member, or a `const xGetters = {…}`) reads off its first parameter. */
function vuexGetterReads(tree: Tree): NonNullable<StoreWatch["getterReads"]> {
  const out: NonNullable<StoreWatch["getterReads"]> = [];
  const tables: Array<{ node: Node; name: string }> = [];
  for (const p of tree.rootNode.descendantsOfType("pair")) {
    const value = p?.childForFieldName("value");
    if (p && value?.type === "object" && /^['"]?getters['"]?$/.test(p.childForFieldName("key")?.text ?? "")) tables.push({ node: value, name: "getters" });
  }
  for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
    const value = d?.childForFieldName("value");
    const name = d?.childForFieldName("name")?.text ?? "";
    if (d && value?.type === "object" && /(?:^|[a-z])[gG]etters$/.test(name)) tables.push({ node: value, name });
  }
  // Each table is the value of one pair or one declarator: no node is listed twice.
  for (const { node, name: table } of tables) {
    for (const m of node.namedChildren) {
      const fn = m?.type === "method_definition" ? m : m?.type === "pair" ? m.childForFieldName("value") : null;
      const key = fn ? m!.childForFieldName(m!.type === "pair" ? "key" : "name")?.text.replace(/^['"]|['"]$/g, "") : null;
      if (!key || !fn) continue;
      let paths: string[];
      if (m!.type === "method_definition") {
        const param = fn.childForFieldName("parameters")?.namedChildren[0];
        const pname = (param?.type === "required_parameter" ? param.childForFieldName("pattern") : param)?.text;
        const body = fn.childForFieldName("body");
        paths = [];
        if (pname && body) for (const id of body.descendantsOfType("identifier")) {
          if (!id || id.text !== pname || id.parent?.type !== "member_expression" || id.parent.childForFieldName("object")?.id !== id.id) continue;
          const { path, deep } = readPath(id);
          if (path.length > 0) paths.push(path.join(".") + (deep ? "*" : ""));
        }
      } else paths = stateParamReads(fn, (rest) => rest);
      if (paths.length > 0 && !out.some((g) => g.name === key && g.table === table)) out.push({ name: key, table, paths: [...new Set(paths)] });
    }
  }
  return out;
}

type Write = NonNullable<StoreWatch["writes"]>[number];
type Derived = NonNullable<StoreWatch["derived"]>[number];
type Fn = { name: string; line: number; endLine: number };

const FUNCTION_NODES: ReadonlySet<string> = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "method_definition", "generator_function"]);
const REF_CELLS = new Set(["ref", "shallowRef", "customRef", "useStorage", "useLocalStorage", "useSessionStorage"]);
const REACTIVE_CELLS = new Set(["reactive", "shallowReactive"]);

/** Writes to the state of each Pinia store a file defines. */
function storeWrites(tree: Tree, functions: readonly Fn[], derived: Derived[]): Write[] {
  const out: Write[] = [];
  for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
    const store = d ? piniaStoreOf(d) : null;
    if (!store) continue;
    if (store.options) optionStoreWrites(store, functions, out);
    else if (store.setup) setupStoreWrites(store, functions, out, derived, false);
  }
  return out;
}

/** What a write target names: the first member below the root and the path (`filters.league`, an element `picked.[]`). */
interface Target { path: string[]; root: string }

/** Whether `n` is the root a store's state hangs off: `this`, or one of the identifiers naming it. */
type RootTest = (n: Node) => string | null;

function targetOf(node: Node | null, rootOf: RootTest, mutated: boolean): Target | null {
  let n = node;
  const steps: Array<string | null> = [];
  while (n && (n.type === "member_expression" || n.type === "subscript_expression")) {
    steps.unshift(n.type === "member_expression" ? n.childForFieldName("property")?.text ?? null : null);
    n = n.childForFieldName("object");
  }
  const root = n ? rootOf(n) : null;
  if (root === null) return null;
  const cut = steps.indexOf(null);
  const path = (cut < 0 ? steps : steps.slice(0, cut)).map((x) => x ?? "[]");
  if (cut >= 0 || mutated) path.push("[]");
  return { path, root };
}

/** Visits `body` without entering a function that has a `this` or locals of its own (an arrow keeps both). */
function walk(body: Node, visit: (n: Node) => void): void {
  const go = (n: Node): void => {
    visit(n);
    for (const c of n.namedChildren) if (c && !FUNCTION_NODES.has(c.type)) go(c);
  };
  go(body);
}

function pushWrite(out: Write[], functions: readonly Fn[], node: Node, store: string, path: readonly string[], falsy: boolean, instance = false): void {
  const line = node.startPosition.row + 1;
  const fn = innermost(functions, line);
  if (!fn) return;
  const joined = path.join(".");
  const id = `${store}\0${joined}\0${fn}\0${line}`;
  if (out.some((w) => `${w.store}\0${w.path}\0${w.function}\0${w.line}` === id)) return;
  out.push({ store, path: joined, function: fn, line, spelling: (path.find((p) => p !== "[]") ?? "").replace(/^~/, ""), ...(falsy ? { falsy: true } : {}), ...(instance ? { instance: true } : {}) });
}

/** The writes of one function body, given what names the state there. */
function writesIn(body: Node, rootOf: RootTest, emit: (node: Node, path: string[], falsy: boolean) => void, patchParam: (fn: Node) => void): void {
  walk(body, (n) => {
    if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression" || n.type === "update_expression") {
      const left = n.type === "update_expression" ? n.childForFieldName("argument") : n.childForFieldName("left");
      const t = targetOf(left, rootOf, false);
      if (t && t.path.length > 0) emit(n, t.path, n.type === "assignment_expression" && FALSY.test(n.childForFieldName("right")?.text.trim() ?? ""));
      return;
    }
    if (n.type !== "call_expression") return;
    const callee = n.childForFieldName("function");
    if (callee?.type !== "member_expression") return;
    const method = callee.childForFieldName("property")?.text ?? "";
    const object = callee.childForFieldName("object");
    // `this.$patch({ filters })` / `this.$patch((state) => { state.filters.league = x })` / `this.$reset()`
    if (object && rootOf(object) !== null && (method === "$patch" || method === "$reset")) {
      const arg = argumentsOf(n)[0];
      if (method === "$reset" || !arg) emit(n, [], false);
      else if (arg.type === "object") {
        for (const p of arg.namedChildren) {
          const key = p?.type === "shorthand_property_identifier" ? p.text : p?.type === "pair" ? p.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "") : null;
          if (key) emit(p!, [key], false);
          else emit(n, [], false);
        }
      } else if (arg.type === "arrow_function" || arg.type === "function_expression" || arg.type === "function") patchParam(arg);
      else emit(n, [], false);
      return;
    }
    if (!MUTATORS.has(method)) return;
    const t = targetOf(object ?? null, rootOf, true);
    if (t && t.path.length > 0 && t.path[0] !== "[]") emit(n, t.path, false);
  });
}

/** The composables a file declares: `function useClubs() {…}`, `export const useClubs = () => {…}`. */
function composableWrites(tree: Tree, functions: readonly Fn[], out: Write[], derived: Derived[]): void {
  const found: Array<{ name: string; fn: Node }> = [];
  const declare = (n: Node | null | undefined): void => {
    if (!n) return;
    if (n.type === "export_statement") return declare(n.childForFieldName("declaration"));
    if (n.type === "function_declaration") {
      const name = n.childForFieldName("name")?.text;
      if (name && /^use[A-Z]/.test(name)) found.push({ name, fn: n });
    } else if (n.type === "lexical_declaration" || n.type === "variable_declaration") {
      for (const d of n.namedChildren) {
        const name = d?.type === "variable_declarator" ? d.childForFieldName("name") : null;
        const value = d?.childForFieldName("value");
        if (name?.type === "identifier" && /^use[A-Z]/.test(name.text) && (value?.type === "arrow_function" || value?.type === "function_expression" || value?.type === "function")) found.push({ name: name.text, fn: value });
      }
    }
  };
  for (const st of tree.rootNode.namedChildren) declare(st);
  // A ref declared outside the function is one every caller shares; one inside it belongs to each call.
  const shared = new Map<string, { reactive: boolean; opaque: boolean; shared?: true }>();
  for (const st of tree.rootNode.namedChildren) {
    const decl = st?.type === "export_statement" ? st.childForFieldName("declaration") : st;
    if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") continue;
    for (const d of decl.namedChildren) {
      const value = d?.type === "variable_declarator" ? d.childForFieldName("value") : null;
      const name = d?.childForFieldName("name");
      if (value?.type !== "call_expression" || name?.type !== "identifier") continue;
      const hook = value.childForFieldName("function")?.text ?? "";
      if (REF_CELLS.has(hook)) shared.set(name.text, { reactive: false, opaque: hook === "shallowRef" || hook === "customRef", shared: true });
      else if (REACTIVE_CELLS.has(hook)) shared.set(name.text, { reactive: true, opaque: hook === "shallowReactive", shared: true });
    }
  }
  for (const c of found) setupStoreWrites({ binding: c.name, className: c.name, options: null, setup: c.fn }, functions, out, derived, true, shared);
}

function optionStoreWrites(store: PiniaStore, functions: readonly Fn[], out: Write[]): void {
  const actions: Node[] = [];
  for (const member of store.options!.namedChildren) {
    const key = member?.type === "pair" ? member.childForFieldName("key")?.text : null;
    const value = member?.type === "pair" ? member.childForFieldName("value") : null;
    if (key !== "actions" || value?.type !== "object") continue;
    for (const a of value.namedChildren) {
      if (a?.type === "method_definition") actions.push(a);
      else if (a?.type === "pair" && a.childForFieldName("value") && FUNCTION_NODES.has(a.childForFieldName("value")!.type)) actions.push(a.childForFieldName("value")!);
    }
  }
  const emit = (node: Node, path: string[], falsy: boolean) => pushWrite(out, functions, node, store.className, path, falsy);
  for (const fn of actions) {
    const body = fn.childForFieldName("body");
    if (!body) continue;
    const params = new Set<string>();
    const rootOf: RootTest = (n) => (n.type === "this" ? "this" : n.type === "identifier" && params.has(n.text) ? n.text : null);
    const patchParam = (cb: Node): void => {
      const p = cb.childForFieldName("parameters")?.namedChildren[0] ?? cb.childForFieldName("parameter");
      const cbBody = cb.childForFieldName("body");
      if (p?.type !== "identifier" || !cbBody) return;
      params.add(p.text);
      writesIn(cbBody, rootOf, emit, patchParam);
      params.delete(p.text);
    };
    writesIn(body, rootOf, emit, patchParam);
  }
}

function setupStoreWrites(store: PiniaStore, functions: readonly Fn[], out: Write[], derived: Derived[], composable: boolean, shared?: ReadonlyMap<string, { reactive: boolean; opaque: boolean; shared?: true }>): void {
  const body = store.setup!.childForFieldName("body");
  if (body?.type !== "statement_block") return;
  // The refs and reactive objects the setup declares, and the key the returned object gives each.
  const cells = new Map<string, { reactive: boolean; opaque: boolean; shared?: true }>();
  const exposed = new Map<string, string>();
  const computeds = new Map<string, Node>();
  for (const stmt of body.namedChildren) {
    if (stmt?.type === "lexical_declaration" || stmt?.type === "variable_declaration") {
      for (const d of stmt.namedChildren) {
        const value = d?.type === "variable_declarator" ? d.childForFieldName("value") : null;
        const name = d?.childForFieldName("name");
        if (value?.type !== "call_expression" || name?.type !== "identifier") continue;
        const hook = value.childForFieldName("function")?.text ?? "";
        if (REF_CELLS.has(hook)) cells.set(name.text, { reactive: false, opaque: hook === "shallowRef" || hook === "customRef" });
        else if (REACTIVE_CELLS.has(hook)) cells.set(name.text, { reactive: true, opaque: hook === "shallowReactive" });
        else if (hook === "computed") {
          const getter = getterOf(argumentsOf(value)[0]);
          if (getter) computeds.set(name.text, getter);
        }
      }
    } else if (stmt?.type === "return_statement") {
      let ret = stmt.namedChild(0);
      while (ret?.type === "parenthesized_expression") ret = ret.namedChild(0);
      for (const e of ret?.type === "object" ? ret.namedChildren : []) {
        if (e?.type === "shorthand_property_identifier") exposed.set(e.text, e.text);
        else if (e?.type === "pair" && e.childForFieldName("value")?.type === "identifier") {
          const key = e.childForFieldName("key")?.text;
          if (key) exposed.set(e.childForFieldName("value")!.text, key);
        }
      }
    }
  }
  // The state a composable keeps at module level, unless the function declares one of that name itself.
  for (const [name, cell] of shared ?? []) if (!cells.has(name)) cells.set(name, cell);
  // A store's state is what it returns; a composable's private ref is still what its returned computeds read.
  if (!composable) for (const local of [...cells.keys()]) if (!exposed.has(local)) cells.delete(local);
  if (cells.size === 0) return;
  const keyOf = (local: string): string => exposed.get(local) ?? `~${local}`;
  derivedMembers(store.className, cells, computeds, exposed, keyOf, derived);
  // The setup body writes through a ref's `.value`, and through a reactive object's members; nested functions are walked
  // too — the actions are functions of the setup.
  const visitAll = (root: Node): void => {
    const go = (n: Node): void => {
      if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression" || n.type === "update_expression" || n.type === "call_expression") one(n);
      for (const c of n.namedChildren) if (c) go(c);
    };
    go(root);
  };
  const rootOf: RootTest = (n) => (n.type === "identifier" && cells.has(n.text) ? n.text : null);
  const emitFor = (node: Node, t: Target, mutated: boolean, falsy: boolean): void => {
    const cell = cells.get(t.root)!;
    let path = t.path;
    if (!cell.reactive) {
      if (path[0] !== "value") return;
      path = path.slice(1);
    } else if (path.length === 0 && !mutated) return;
    // A shallow ref changes only when its value is replaced, a shallow reactive object when one of its own members is.
    if (cell.opaque && (cell.reactive ? path.length > 1 || mutated : path.length > 0 || mutated)) return;
    pushWrite(out, functions, node, store.className, [keyOf(t.root), ...path], falsy, composable && !cell.shared);
  };
  const one = (n: Node): void => {
    if (n.type === "call_expression") {
      const callee = n.childForFieldName("function");
      if (callee?.type !== "member_expression" || !MUTATORS.has(callee.childForFieldName("property")?.text ?? "")) return;
      const t = targetOf(callee.childForFieldName("object"), rootOf, true);
      if (t) emitFor(n, t, true, false);
      return;
    }
    const left = n.type === "update_expression" ? n.childForFieldName("argument") : n.childForFieldName("left");
    const t = targetOf(left, rootOf, false);
    if (t) emitFor(n, t, false, n.type === "assignment_expression" && FALSY.test(n.childForFieldName("right")?.text.trim() ?? ""));
  };
  visitAll(body);
}

/**
 * The returned computeds of a composable and the state each reads — `const total = computed(() => clubs.value.length)`
 * is `total` → `clubs*` — through the computeds it reads in turn. A watcher on `total` in another file runs when
 * something writes `clubs`. A ref read as stated (`() => clubs.value`) is shallow, one used (`.length`, a call) is read through.
 */
function derivedMembers(store: string, cells: ReadonlyMap<string, { reactive: boolean; opaque: boolean; shared?: true }>, computeds: ReadonlyMap<string, Node>, exposed: ReadonlyMap<string, string>, keyOf: (local: string) => string, out: Derived[]): void {
  const readsOf = (name: string, seen: Set<string>): string[] => {
    const body = computeds.get(name);
    if (!body || seen.has(name)) return [];
    seen.add(name);
    const reads = new Set<string>();
    const visit = (n: Node): void => {
      if (n.type === "identifier" && !(n.parent?.type === "member_expression" && n.parent.childForFieldName("property")?.id === n.id)) {
        const cell = cells.get(n.text);
        if (cell) {
          const { path, deep, returned } = readPath(n);
          const rest = cell.reactive ? path : path[0] === "value" ? path.slice(1) : null;
          if (rest) reads.add([keyOf(n.text), ...rest].join(".") + (deep || !returned ? "*" : ""));
        } else if (computeds.has(n.text)) {
          // `value` of another computed: what it reads (read through when this one uses it).
          const { deep, returned } = readPath(n);
          for (const r of readsOf(n.text, seen)) reads.add(deep || !returned ? r.replace(/\*?$/, "*") : r);
        }
        return;
      }
      for (const c of n.namedChildren) if (c) visit(c);
    };
    visit(body);
    return [...reads];
  };
  for (const [local, member] of exposed) {
    if (!computeds.has(local)) continue;
    const reads = readsOf(local, new Set());
    if (reads.length > 0) out.push({ store, member, reads });
  }
}

/** Whether a function of `file` calls `name` — bare or through a local (`load()`, `clubs.load()`). */
function callsFunction(file: FileAnalysis, name: string): boolean {
  const fns = [...file.functions, ...file.classes.flatMap((c) => c.methods)];
  return fns.some((f) => f.calls.some((c) => c.name === name || c.name.endsWith(`.${name}`)));
}

/**
 * Joins a watcher to the actions writing the state it reads: an INFERRED `dispatch` link from the function writing to
 * the callback (`dispatch:store-watch`), `callName` the member written. The store is the file and class the watcher's
 * factory resolves to — through the import, else the one project function of that name.
 */
export class JsStoreWatchResolver implements DispatchResolver {
  readonly id = "store-watch";
  readonly languages = ["typescript", "javascript"] as FileAnalysis["language"][];
  readonly priority = 35;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    if (!analyses.some((a) => a.storeWatch?.watchers?.length) || !analyses.some((a) => a.storeWatch?.writes?.length)) return [];
    const files: Files = { byPath: new Map(analyses.map((a) => [a.filePath, a])), filePathMap: buildFilePathMap(analyses) };
    /** The file declaring `name` below a module that only forwards it (`export { useClubStore } from './club-store'`, `export * from`). */
    const forwarded = (module: FileAnalysis, name: string, hops: number): { file: FileAnalysis; name: string } | null => {
      if (module.functions.some((f) => f.name === name)) return { file: module, name };
      if (hops <= 0) return null;
      for (const e of module.exports) {
        if (!e.source || (e.name !== name && e.name !== "*")) continue;
        const target = resolveTarget(e.source, module.filePath, files.filePathMap);
        const at = target ? files.byPath.get(target) : undefined;
        const hit = at ? forwarded(at, e.name === "*" ? name : e.sourceName ?? name, hops - 1) : null;
        if (hit) return hit;
      }
      return null;
    };
    // Nuxt auto-imports a store from `stores/` and a composable from `composables/` with no import line: the one project
    // function of that name, in the caller's own app first (two apps may each have a `useClubs`).
    let byName: Map<string, FileAnalysis[]> | null = null;
    let nuxtProjects: Set<string> | null = null;
    const declaring = (factory: string, caller: FileAnalysis): FileAnalysis[] => {
      if (!byName) {
        byName = new Map();
        for (const a of analyses) {
          for (const f of a.functions) {
            const composable = a.storeWatch?.writes?.some((w) => !w.viaFactory && w.store === f.name) || a.storeWatch?.derived?.some((d) => d.store === f.name);
            if (f.returnType || composable) (byName.get(f.name) ?? byName.set(f.name, []).get(f.name)!).push(a);
          }
        }
      }
      // A composable known only by the state it writes (no declared return type) is auto-imported only by Nuxt: the
      // caller's sub-project must hold a `nuxt.config`, or a plain `useX()` from a global or a `require` would join it.
      nuxtProjects ??= new Set(analyses.filter((a) => NUXT_CONFIG.test(a.filePath)).map((a) => a.projectId ?? ""));
      const nuxt = nuxtProjects.has(caller.projectId ?? "");
      const all = (byName.get(factory) ?? []).filter((a) => nuxt || a.functions.some((f) => f.name === factory && f.returnType));
      if (all.length <= 1) return all;
      return all.filter((a) => a.projectId !== undefined && a.projectId === caller.projectId);
    };
    const stores = new Map<string, string | null>();
    const storeOf = (file: FileAnalysis, factory: string): string | null => {
      const memo = `${file.filePath}\0${factory}`;
      if (stores.has(memo)) return stores.get(memo)!;
      let home = homeOf(file, factory, "function", files);
      const imp = file.imports.find((i) => i.specifiers.includes(factory));
      if (!home && imp) {
        const target = resolveTarget(imp.source, file.filePath, files.filePathMap);
        const at = target ? files.byPath.get(target) : undefined;
        if (at) home = forwarded(at, imp.aliases?.[factory] ?? factory, 4);
      } else if (!home) {
        const all = declaring(factory, file);
        if (all.length === 1) home = { file: all[0]!, name: factory };
      }
      const fn = home?.file.functions.find((f) => f.name === home!.name);
      const cls = fn?.returnType ? home!.file.classes.find((c) => c.name === fn.returnType) : undefined;
      // A composable names itself: its returned refs are the state, its own functions write them.
      const composable = home && !cls && (home!.file.storeWatch?.writes?.some((w) => !w.viaFactory && w.store === home!.name) || home!.file.storeWatch?.derived?.some((d) => d.store === home!.name));
      const key = home && cls ? `${home.file.filePath}#${cls.name}` : composable ? `${home!.file.filePath}#${home!.name}` : null;
      stores.set(memo, key);
      return key;
    };
    // Writes by the store they land in: a store file's own name the class, a component's the factory it asked for.
    const writesByStore = new Map<string, Array<{ file: FileAnalysis; write: Write }>>();
    for (const a of analyses) {
      for (const w of a.storeWatch?.writes ?? []) {
        const key = w.viaFactory ? storeOf(a, w.store) : `${a.filePath}#${w.store}`;
        if (key) (writesByStore.get(key) ?? writesByStore.set(key, []).get(key)!).push({ file: a, write: w });
      }
    }
    // The computeds a store or composable returns, by store: a watcher on one runs when what it reads is written.
    const derivedByStore = new Map<string, Map<string, string[]>>();
    for (const a of analyses) {
      for (const d of a.storeWatch?.derived ?? []) {
        const key = `${a.filePath}#${d.store}`;
        (derivedByStore.get(key) ?? derivedByStore.set(key, new Map()).get(key)!).set(d.member, d.reads);
      }
    }
    /** `total`, `total.value` or `total*` → what `total` reads, when it is a computed of the store. */
    const expand = (key: string | null, path: string): string[] => {
      const members = key ? derivedByStore.get(key) : undefined;
      const head = path.replace(/\*$/, "").split(".")[0] ?? "";
      const reads = members?.get(head);
      return reads ? reads.map((r) => (path.endsWith("*") ? r.replace(/\*?$/, "*") : r)) : [path];
    };
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const a of analyses) {
      const watchers = a.storeWatch?.watchers;
      if (!watchers) continue;
      const immediateInFile = new Set((a.reactiveCells?.triggers ?? []).filter((t) => t.immediate).map((t) => t.function));
      for (const w of watchers) {
        const target = a.functions.find((f) => f.name === w.function) ?? a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` }))).find((f) => f.name === w.function);
        if (!target) continue;
        if (w.immediate && w.function !== "<setup>" && !immediateInFile.has(w.function) && a.functions.some((f) => f.name === "<setup>")) {
          const id = `<setup>\0${a.filePath}\0${w.line}\0${w.function}`;
          if (!seen.has(id)) {
            seen.add(id);
            links.push({ sourceFile: a.filePath, sourceSymbol: "<setup>", sourceLine: w.line, callName: "immediate", targetFile: a.filePath, targetSymbol: w.function, targetLine: target.line, confidence: "INFERRED", strategy: "dispatch:store-watch", relation: "dispatch" });
          }
        }
        for (const read of w.reads) {
          const key = storeOf(a, read.factory);
          const readPaths = expand(key, read.path);
          for (const { file, write } of (key ? writesByStore.get(key) : undefined) ?? []) {
            if (file === a && write.function === w.function) continue;
            if (w.truthyOnly && write.falsy) continue;
            if (write.path !== "" && read.path !== "*" && !readPaths.some((r) => sameCell(`s:${write.path}`, `s:${r}`))) continue;
            // State each call of a composable creates is changed only by what the watching component itself calls.
            if (write.instance && !callsFunction(a, write.function)) continue;
            const id = `${file.filePath}\0${write.function}\0${write.line}\0${a.filePath}\0${w.function}`;
            if (seen.has(id)) continue;
            seen.add(id);
            links.push({
              sourceFile: file.filePath,
              sourceSymbol: write.function,
              sourceLine: write.line,
              callName: write.spelling || read.path.replace(/\*$/, ""),
              targetFile: a.filePath,
              targetSymbol: w.function,
              targetLine: target.line,
              confidence: "INFERRED",
              strategy: "dispatch:store-watch",
              relation: "dispatch",
            });
          }
        }
      }
    }
    return links;
  }
}
