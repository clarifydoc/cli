import type { Node, Tree } from "web-tree-sitter";
import {
  SCOPES,
  TRUTHY_ONLY,
  VUE_EFFECT,
  VUE_SOURCES,
  VUE_WATCH,
  argumentsOf,
  callbackOf,
  getterOf,
  holdCallbacks,
  importSources,
  isDeep,
  isOption,
  readPath,
  type CellFacts,
} from "./reactive-cells.js";

/**
 * Watchers of state a store holds. A component reads a store through the instance its factory hands it
 * (`const store = useClubStore()`), a ref onto one member (`const { filters } = storeToRefs(store)`) or a computed
 * over either, and `watch(() => store.filters.league, …)` runs its callback when an action of that store writes the
 * member. The store is another file's, so nothing here says which class the factory builds: each read names the
 * factory as written (`useClubStore`) and the member path below the store (`filters.league`, `picked*` read through),
 * and the project pass (`store-watch.ts`) resolves the factory and joins the actions writing the path.
 *
 * Only a factory named `use…Store`, or one handed to `storeToRefs`, is read as a store: any other `useX()` is a
 * composable, and its callback is not split out of the component for it.
 */

/** A read of a store's state: the factory as written and the path below the store (`filters.league`, `picked*`). */
export interface StoreRead { factory: string; path: string }

/** A watcher whose source reads store state. `truthyOnly`: it runs only when the value turns truthy (VueUse `whenever`). */
export interface StoreTrigger { reads: StoreRead[]; hook: string; callback: Node | null; callee: string | null; at: Node; immediate?: boolean; truthyOnly?: boolean }

type Local =
  | { kind: "store"; factory: string }
  | { kind: "ref"; factory: string; member: string }
  | { kind: "derived"; reads: StoreRead[] };

const STORE_FACTORY = /^use[A-Z][\w$]*Store$/;

export function withStoreWatchers(tree: Tree, facts: CellFacts, text: string): CellFacts {
  if (!/Store\b|storeToRefs/.test(text) || !/\b(?:watch\w*|whenever|\w+Watch)\s*\(/.test(text)) return facts;
  const sources = importSources(tree.rootNode);
  const fromVue = (name: string): boolean => {
    const src = sources.get(name);
    return src === undefined || VUE_SOURCES.test(src);
  };
  const byScope = new Map<number, Map<string, Local>>();
  const scopeOf = (n: Node): Node => {
    for (let p = n.parent; p; p = p.parent) if (SCOPES.has(p.type) || p.type === "program") return p;
    return n.tree.rootNode;
  };
  const declare = (at: Node, name: string, local: Local): void => {
    const scope = scopeOf(at);
    (byScope.get(scope.id) ?? byScope.set(scope.id, new Map()).get(scope.id)!).set(name, local);
  };
  const resolve = (name: string, at: Node): Local | undefined => {
    for (let p: Node | null = at; p; p = p.parent) {
      if (!SCOPES.has(p.type) && p.type !== "program") continue;
      const hit = byScope.get(p.id)?.get(name);
      if (hit) return hit;
    }
    return undefined;
  };
  /** The store factory an expression stands for: a store local, or a `useClubStore()` call. */
  const factoryOf = (e: Node | null | undefined): string | null => {
    if (!e) return null;
    if (e.type === "identifier") {
      const l = resolve(e.text, e);
      return l?.kind === "store" ? l.factory : null;
    }
    if (e.type === "call_expression") {
      const callee = e.childForFieldName("function");
      return callee?.type === "identifier" && STORE_FACTORY.test(callee.text) && argumentsOf(e).length <= 1 ? callee.text : null;
    }
    return null;
  };

  /** What a getter body reads of store state. */
  const readsOf = (expr: Node | null): StoreRead[] => {
    const out: StoreRead[] = [];
    if (!expr) return out;
    const add = (factory: string, path: readonly string[], deep: boolean): void => {
      if (path.length === 0 || path[0]!.startsWith("$")) return;
      const read = { factory, path: path.join(".") + (deep ? "*" : "") };
      if (!out.some((r) => r.factory === read.factory && r.path === read.path)) out.push(read);
    };
    const visit = (n: Node): void => {
      if (n.type === "identifier") {
        const local = resolve(n.text, n);
        if (local) {
          const { path, deep, returned } = readPath(n);
          if (local.kind === "store") add(local.factory, path, deep || !returned);
          else if (local.kind === "ref") {
            // `filters.value…`: a ref's value is read as stated when a getter only hands it back, through when it is used.
            if (path[0] === "value") add(local.factory, [local.member, ...path.slice(1)], deep || (path.length === 1 ? !returned : false));
          } else for (const r of local.reads) if (!out.some((o) => o.factory === r.factory && o.path === r.path)) out.push(r);
          return;
        }
      } else if (n.type === "call_expression") {
        // `useClubStore().filters.league`: the call is the store.
        const f = factoryOf(n);
        if (f) {
          let top: Node = n;
          const path: string[] = [];
          let deep = false;
          for (let p = top.parent; p; top = p, p = p.parent) {
            if (p.type !== "member_expression" || p.childForFieldName("object")?.id !== top.id) break;
            const prop = p.childForFieldName("property")?.text;
            if (!prop) break;
            const call = p.parent;
            if ((call?.type === "call_expression" && call.childForFieldName("function")?.id === p.id) || prop === "length") {
              deep = true;
              break;
            }
            path.push(prop);
          }
          add(f, path, deep || !(top.parent?.type === "arrow_function" && top.parent.childForFieldName("body")?.id === top.id));
          return;
        }
      }
      for (const c of n.namedChildren) if (c) visit(c);
    };
    visit(expr);
    return out;
  };

  /** The reads a watcher's source stands for. */
  const sourceReads = (src: Node | undefined): StoreRead[] => {
    const out: StoreRead[] = [];
    if (!src) return out;
    const push = (rs: readonly StoreRead[]) => {
      for (const r of rs) if (!out.some((o) => o.factory === r.factory && o.path === r.path)) out.push(r);
    };
    const one = (n: Node): void => {
      if (n.type === "identifier") {
        const l = resolve(n.text, n);
        // `watch(store, …)`: a store is a reactive object, read through whole.
        if (l?.kind === "store") push([{ factory: l.factory, path: "*" }]);
        else if (l?.kind === "ref") push([{ factory: l.factory, path: l.member }]);
        else if (l?.kind === "derived") push(l.reads);
      } else if (n.type === "arrow_function" || n.type === "function_expression" || n.type === "function") {
        push(readsOf(n.childForFieldName("body")));
      } else if (n.type === "member_expression") {
        // `watch(store.filters, …)`: the object a store member holds is watched through.
        push(readsOf(n).map((r) => ({ ...r, path: r.path.replace(/\*?$/, "*") })));
      }
    };
    if (src.type === "array") for (const el of src.namedChildren) el && one(el);
    else one(src);
    return out;
  };

  // A local handed to `storeToRefs` is a store whatever its factory is called.
  const viaStoreToRefs = new Set<string>();
  for (const c of tree.rootNode.descendantsOfType("call_expression")) {
    if (c?.childForFieldName("function")?.text !== "storeToRefs") continue;
    const a = argumentsOf(c)[0];
    if (a?.type === "identifier") viaStoreToRefs.add(a.text);
  }
  // Declarations, in source order: a computed reads the locals declared above it.
  for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
    if (!d) continue;
    const value = d.childForFieldName("value");
    const name = d.childForFieldName("name");
    if (value?.type !== "call_expression" || !name) continue;
    const callee = value.childForFieldName("function");
    const hook = callee?.type === "identifier" ? callee.text : "";
    const args = argumentsOf(value);
    if (name.type === "identifier") {
      const factory = factoryOf(value) ?? (viaStoreToRefs.has(name.text) && callee?.type === "identifier" && args.length <= 1 ? callee.text : null);
      if (factory) declare(d, name.text, { kind: "store", factory });
      else if (hook === "computed" && fromVue(hook)) {
        const reads = readsOf(getterOf(args[0]));
        if (reads.length > 0) declare(d, name.text, { kind: "derived", reads });
      } else if (hook === "toRef" && args.length === 2 && args[1]!.type === "string") {
        const f = factoryOf(args[0]);
        if (f) declare(d, name.text, { kind: "ref", factory: f, member: args[1]!.text.slice(1, -1) });
      }
    } else if (name.type === "object_pattern" && hook === "storeToRefs" && args.length === 1) {
      const factory = factoryOf(args[0]);
      if (!factory) continue;
      for (const p of name.namedChildren) {
        if (p?.type === "shorthand_property_identifier_pattern") declare(d, p.text, { kind: "ref", factory, member: p.text });
        else if (p?.type === "pair_pattern" && p.childForFieldName("value")?.type === "identifier") {
          const member = p.childForFieldName("key")?.text;
          if (member) declare(d, p.childForFieldName("value")!.text, { kind: "ref", factory, member });
        }
      }
    }
  }
  if (byScope.size === 0) return facts;

  const found: StoreTrigger[] = [];
  for (const n of tree.rootNode.descendantsOfType("call_expression")) {
    const callee = n?.childForFieldName("function");
    if (!n || callee?.type !== "identifier" || !fromVue(callee.text)) continue;
    const args = argumentsOf(n);
    if (VUE_WATCH.has(callee.text) && args.length >= 2) {
      let reads = sourceReads(args[0]);
      if (reads.length === 0) continue;
      // `{ deep: true }` reads every source through.
      if (isDeep(args[2])) reads = reads.map((r) => ({ ...r, path: r.path.replace(/\*?$/, "*") }));
      const immediate = callee.text === "watchImmediate" || isOption(args[2], "immediate");
      found.push({ reads, hook: callee.text, ...callbackOf(args[1]!), at: n, ...(immediate ? { immediate: true } : {}), ...(TRUTHY_ONLY.has(callee.text) ? { truthyOnly: true } : {}) });
    } else if (VUE_EFFECT.has(callee.text) && args[0]) {
      const body = getterOf(args[0]);
      const reads = readsOf(body);
      if (reads.length > 0) found.push({ reads, hook: callee.text, ...callbackOf(args[0]), at: n, immediate: true });
    }
  }
  if (found.length === 0) return facts;
  return { ...facts, held: holdCallbacks(facts.held, found), storeTriggers: found };
}
