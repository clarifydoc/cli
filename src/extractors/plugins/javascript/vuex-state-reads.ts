import type { Node, Tree } from "web-tree-sitter";
import { VUE_SOURCES, VUE_WATCH, argumentsOf, callbackOf, computedMembers, getterOf, holdCallbacks, importSources, isDeep, isOption, optionKey, optionsObjects, optionsWatchers, readPath, type CellFacts } from "./reactive-cells.js";
import { PROJECT_SOURCE, VUEX_FACTORY, type StoreTrigger } from "./store-reads.js";

/** A `watch` key naming Vuex state: `'$store.state.clubs.list'`. */
const VUEX_STATE_KEY = /^\$store\.state\.([\w$]+(?:\.[\w$]+)*)$/;

/**
 * Watchers of Vuex state in an Options API component: a `watch` key naming the state (`'$store.state.clubs.list'`) or a
 * computed that reads it — `list() { return this.$store.state.clubs.list }`, a `...mapState('clubs', ['list'])` entry,
 * `mapState({ rows: (state) => state.clubs.rows })` — through other computeds. Each is a store trigger on the factory
 * `$vuex` with the path from the root state; the Vuex state resolver (`vuex-state.ts`) joins it to the mutations writing
 * that path of the module the namespace names. `deep: true` reads the path through; a computed handing the member back
 * reads it as stated, one using it (`.length`, a call, a loop) reads it through. `mapState` was only a read before: no
 * watcher on its computed ran when a mutation wrote the state.
 */
export function withVuexOptions(tree: Tree, facts: CellFacts, text: string): CellFacts {
  if (!text.includes("watch") || !/\$store\b|mapState/.test(text)) return facts;
  const components = optionsObjects(tree);
  if (components.length === 0) return facts;
  const found: StoreTrigger[] = [];
  for (const options of components) {
    const computed = computedMembers(options);
    const mapped = mapStateMembers(options);
    const memo = new Map<string, string[]>();
    /** The state paths a computed member reads, `*`-marked when read through. */
    const readsOfMember = (name: string, seen: Set<string>): string[] => {
      const top = seen.size === 0;
      const known = memo.get(name);
      if (known) return known;
      if (seen.has(name)) return [];
      seen.add(name);
      const out = new Set<string>(mapped.get(name) ?? []);
      const body = computed.get(name);
      for (const t of body?.descendantsOfType("this") ?? []) {
        if (!t || t.parent?.type !== "member_expression" || t.parent.childForFieldName("object")?.id !== t.id) continue;
        const { path, deep } = readPath(t);
        if (path[0] === "$store" && path[1] === "state" && path.length > 2) {
          // The member handed back as it is (`return this.$store.state.x`) is read as stated; any use reads through.
          let top: Node = t;
          while (top.parent?.type === "member_expression" && top.parent.childForFieldName("object")?.id === top.id) top = top.parent;
          const handedBack = top.parent?.type === "return_statement" || (top.parent?.type === "arrow_function" && top.parent.childForFieldName("body")?.id === top.id);
          out.add(path.slice(2).join(".") + (deep || !handedBack ? "*" : ""));
        } else if (path[0] && (computed.has(path[0]) || mapped.has(path[0]))) {
          for (const r of readsOfMember(path[0], seen)) out.add(r);
        }
      }
      const result = [...out];
      // A result cut short by a computed still being read above it is not the member's own.
      if (top) memo.set(name, result);
      return result;
    };
    for (const w of optionsWatchers(options)) {
      const direct = VUEX_STATE_KEY.exec(w.path)?.[1];
      const paths = direct ? [direct] : /^[\w$]+$/.test(w.path) && (computed.has(w.path) || mapped.has(w.path)) ? readsOfMember(w.path, new Set()) : [];
      if (paths.length === 0) continue;
      const reads = paths.map((p) => ({ factory: VUEX_FACTORY, path: w.deep && !p.endsWith("*") ? `${p}*` : p }));
      for (const cb of w.callbacks) {
        // The callback is the method's own function (`optionNames`), or a method the key names.
        if (!cb.node && !cb.callee) continue;
        found.push({ reads, hook: "watch", callback: cb.node, callee: cb.callee ?? null, at: w.member, ...(w.immediate ? { immediate: true } : {}) });
      }
    }
  }
  if (found.length === 0) return facts;
  return { ...facts, storeTriggers: [...(facts.storeTriggers ?? []), ...found] };
}

/** `computed: { ...mapState('clubs', ['list']) }`: each member name → the state paths it reads, from the root state. */
function mapStateMembers(options: Node): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of options.namedChildren) {
    if (m?.type !== "pair" || optionKey(m.childForFieldName("key")) !== "computed") continue;
    const group = m.childForFieldName("value");
    const calls = group?.type === "call_expression" ? [group] : group?.type === "object" ? group.namedChildren.filter((c) => c?.type === "spread_element").map((c) => c!.namedChildren[0]) : [];
    for (const call of calls) {
      if (call?.type !== "call_expression") continue;
      for (const [k, v] of mapStateCall(call)) out.set(k, v);
    }
  }
  return out;
}

/** What one `mapState(…)` call binds: each member name → the state paths it reads (empty when the call is not `mapState`). */
function mapStateCall(call: Node): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const callee = call.childForFieldName("function");
  if (callee?.type === "identifier" ? callee.text !== "mapState" : !(callee?.type === "member_expression" && callee.childForFieldName("property")?.text === "mapState")) return out;
  let args = argumentsOf(call);
  let ns = "";
  if (args[0]?.type === "string" && args.length >= 2) {
    ns = args[0].text.slice(1, -1).split("/").filter(Boolean).join(".");
    args = args.slice(1);
  }
  const at = (rest: string): string => (ns ? `${ns}.${rest}` : rest);
  const spec = args[0];
  if (spec?.type === "array") {
    for (const el of spec.namedChildren) if (el?.type === "string") out.set(el.text.slice(1, -1), [at(el.text.slice(1, -1))]);
  } else if (spec?.type === "object") {
    for (const p of spec.namedChildren) {
      if (p?.type === "shorthand_property_identifier") {
        out.set(p.text, [at(p.text)]);
        continue;
      }
      const key = p?.type === "pair" ? optionKey(p.childForFieldName("key")) : null;
      const value = p?.type === "pair" ? p.childForFieldName("value") : null;
      if (!key || !value) continue;
      if (value.type === "string") out.set(key, [at(value.text.slice(1, -1))]);
      else {
        const paths = stateParamReads(value, at);
        if (paths.length > 0) out.set(key, paths);
      }
    }
  }
  return out;
}

/** The state paths a function reads off its first parameter, the state (`(state) => state.clubs.rows`), `*`-marked when read through. */
export function stateParamReads(fn: Node, at: (rest: string) => string): string[] {
  if (fn.type !== "arrow_function" && fn.type !== "function_expression" && fn.type !== "function") return [];
  const param = fn.childForFieldName("parameters")?.namedChildren[0] ?? fn.childForFieldName("parameter");
  const name = (param?.type === "required_parameter" ? param.childForFieldName("pattern") : param)?.text;
  const body = fn.childForFieldName("body");
  if (!name || !body) return [];
  const paths: string[] = [];
  for (const id of body.type === "identifier" ? [body] : body.descendantsOfType("identifier")) {
    if (!id || id.text !== name || id.parent?.type !== "member_expression" || id.parent.childForFieldName("object")?.id !== id.id) continue;
    const { path, deep, returned } = readPath(id);
    let top: Node = id;
    while (top.parent?.type === "member_expression" && top.parent.childForFieldName("object")?.id === top.id) top = top.parent;
    if (path.length > 0) paths.push(at(path.join(".")) + (deep || !(returned || top.parent?.type === "return_statement") ? "*" : ""));
  }
  return paths;
}

/** A name in `watch: { … }`'s place the component's code states itself: `store.watch(getter, cb)` and `this.$watch(source, cb)`. */
function callbackFor(arg: Node | undefined): { callback: Node | null; callee: string | null } {
  if (arg?.type === "member_expression" && arg.childForFieldName("object")?.type === "this") return { callback: null, callee: arg.childForFieldName("property")?.text ?? null };
  return callbackOf(arg);
}


/**
 * Vuex state watched in code rather than in an Options `watch` key: `this.$watch('$store.state.clubs.list', cb)` /
 * `this.$watch(() => this.$store.state.clubs.list, cb)`, `store.watch((state) => state.clubs.list, cb)` on the instance
 * (`this.$store`, `useStore()` from vuex, a store module imported from the project), and a Composition API `mapState` — the
 * object it returns bound to a `$store` (`computed(mapped.list.bind({ $store: store }))`) — watched through `watch(list, cb)`.
 */
export function withVuexCalls(tree: Tree, facts: CellFacts, text: string): CellFacts {
  if (!/\$watch|\.watch\s*\(|mapState/.test(text) || !/vuex|\$store|[sS]tore/.test(text)) return facts;
  const sources = importSources(tree.rootNode);
  const storeLocals = new Set<string>();
  for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
    const value = d?.childForFieldName("value");
    const name = d?.childForFieldName("name");
    if (value?.type === "call_expression" && name?.type === "identifier" && value.childForFieldName("function")?.text === "useStore" && sources.get("useStore") === "vuex") storeLocals.add(name.text);
  }
  const isStore = (n: Node | null | undefined): boolean => {
    if (!n) return false;
    if (n.type === "identifier") return storeLocals.has(n.text) || (/^(?:store|[\w$]*Store)$/.test(n.text) && PROJECT_SOURCE.test(sources.get(n.text) ?? "") && n.text !== "useStore");
    return n.type === "member_expression" && n.childForFieldName("object")?.type === "this" && n.childForFieldName("property")?.text === "$store";
  };
  const found: StoreTrigger[] = [];
  const push = (reads: string[], cb: { callback: Node | null; callee: string | null }, at: Node, opts: Node | undefined): void => {
    if (reads.length === 0 || (!cb.callback && !cb.callee)) return;
    const deep = isDeep(opts);
    found.push({
      reads: reads.map((p) => ({ factory: VUEX_FACTORY, path: deep && !p.endsWith("*") ? `${p}*` : p })),
      hook: "watch",
      callback: cb.callback,
      callee: cb.callee,
      at,
      ...(isOption(opts, "immediate") ? { immediate: true } : {}),
    });
  };
  // Composition `mapState`: the bound object's members, and the computeds made of them.
  const mapped = new Map<string, Map<string, string[]>>();
  const members = new Map<string, string[]>();
  if (sources.get("mapState") === "vuex") {
    for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
      const value = d?.childForFieldName("value");
      const name = d?.childForFieldName("name");
      if (value?.type !== "call_expression" || !name) continue;
      const table = mapStateCall(value);
      if (table.size === 0) continue;
      if (name.type === "identifier") mapped.set(name.text, table);
      else if (name.type === "object_pattern") {
        for (const p of name.namedChildren) {
          const key = p?.type === "shorthand_property_identifier_pattern" ? p.text : p?.type === "pair_pattern" ? p.childForFieldName("key")?.text : null;
          const local = p?.type === "shorthand_property_identifier_pattern" ? p.text : p?.type === "pair_pattern" ? p.childForFieldName("value")?.text : null;
          if (key && local && table.has(key)) members.set(local, table.get(key)!);
        }
      }
    }
  }
  const derived = new Map<string, string[]>();
  if (mapped.size > 0 || members.size > 0) {
    for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
      const value = d?.childForFieldName("value");
      const name = d?.childForFieldName("name");
      if (value?.type !== "call_expression" || name?.type !== "identifier" || value.childForFieldName("function")?.text !== "computed") continue;
      // `computed(mapped.list.bind({ $store: store }))`, `computed(list.bind(…))` over a destructured member.
      const bound = argumentsOf(value)[0];
      const fn = bound?.type === "call_expression" ? bound.childForFieldName("function") : null;
      if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "bind") continue;
      const target = fn.childForFieldName("object");
      const reads = target?.type === "identifier" ? members.get(target.text)
        : target?.type === "member_expression" && target.childForFieldName("object")?.type === "identifier" ? mapped.get(target.childForFieldName("object")!.text)?.get(target.childForFieldName("property")?.text ?? "")
        : undefined;
      if (reads) derived.set(name.text, reads);
    }
  }
  for (const n of tree.rootNode.descendantsOfType("call_expression")) {
    const callee = n?.childForFieldName("function");
    if (!n || !callee) continue;
    const args = argumentsOf(n);
    if (callee.type === "member_expression" && args.length >= 2) {
      const method = callee.childForFieldName("property")?.text;
      const object = callee.childForFieldName("object");
      if (method === "$watch" && object?.type === "this") {
        // `this.$watch('$store.state.clubs.list', cb)`, `this.$watch(() => this.$store.state.clubs.list, cb)`.
        let source: string | null = null;
        if (args[0]!.type === "string") source = /^\$store\.state\.([\w$]+(?:\.[\w$]+)*)$/.exec(args[0]!.text.slice(1, -1))?.[1] ?? null;
        else {
          const body = getterOf(args[0]);
          const id = body?.type === "member_expression" ? body : null;
          const path = id ? id.text.split(".") : [];
          if (path[0] === "this" && path[1] === "$store" && path[2] === "state" && path.length > 3 && path.every((p) => /^[\w$]+$/.test(p))) source = path.slice(3).join(".");
        }
        if (source) push([source], callbackFor(args[1]), n, args[2]);
      } else if (method === "watch" && isStore(object)) {
        // `store.watch((state) => state.clubs.list, cb)`.
        push(stateParamReads(args[0]!, (rest) => rest), callbackFor(args[1]), n, args[2]);
      }
    } else if (callee.type === "identifier" && VUE_WATCH.has(callee.text) && args.length >= 2 && derived.size > 0 && (sources.get(callee.text) === undefined || VUE_SOURCES.test(sources.get(callee.text)!))) {
      // `watch(list, cb)`, `watch([list, total], cb)`, `watch(() => list.value, cb)` over a `mapState` computed.
      const reads: string[] = [];
      const one = (e: Node | null | undefined): void => {
        if (e?.type === "identifier") reads.push(...(derived.get(e.text) ?? []));
        else if (e?.type === "arrow_function" || e?.type === "function_expression") {
          for (const id of e.childForFieldName("body")?.descendantsOfType("identifier") ?? []) if (id && id.parent?.type === "member_expression" && derived.has(id.text) && id.parent.childForFieldName("object")?.id === id.id) reads.push(...derived.get(id.text)!);
        }
      };
      if (args[0]!.type === "array") for (const el of args[0]!.namedChildren) one(el);
      else one(args[0]);
      push([...new Set(reads)], callbackOf(args[1]), n, args[2]);
    }
  }
  if (found.length === 0) return facts;
  return { ...facts, held: holdCallbacks(facts.held, found), storeTriggers: [...(facts.storeTriggers ?? []), ...found] };
}
