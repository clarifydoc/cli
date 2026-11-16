import type { Node, Tree } from "web-tree-sitter";
import { argumentsOf, computedMembers, optionKey, optionsObjects, optionsWatchers, readPath, type CellFacts } from "./reactive-cells.js";
import { VUEX_FACTORY, type StoreTrigger } from "./store-reads.js";

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
      const callee = call.childForFieldName("function");
      if (callee?.type === "identifier" ? callee.text !== "mapState" : !(callee?.type === "member_expression" && callee.childForFieldName("property")?.text === "mapState")) continue;
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
          else if (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function") {
            const param = value.childForFieldName("parameters")?.namedChildren[0] ?? value.childForFieldName("parameter");
            const name = (param?.type === "required_parameter" ? param.childForFieldName("pattern") : param)?.text;
            const body = value.childForFieldName("body");
            if (!name || !body) continue;
            const paths: string[] = [];
            for (const id of body.type === "identifier" ? [body] : body.descendantsOfType("identifier")) {
              if (!id || id.text !== name || id.parent?.type !== "member_expression" || id.parent.childForFieldName("object")?.id !== id.id) continue;
              const { path, deep, returned } = readPath(id);
              let top: Node = id;
              while (top.parent?.type === "member_expression" && top.parent.childForFieldName("object")?.id === top.id) top = top.parent;
              if (path.length > 0) paths.push(at(path.join(".")) + (deep || !(returned || top.parent?.type === "return_statement") ? "*" : ""));
            }
            if (paths.length > 0) out.set(key, paths);
          }
        }
      }
    }
  }
  return out;
}
