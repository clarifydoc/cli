import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { sameCell } from "../../../core/reactive-triggers.js";
import { GETTER_READ, VUEX_FACTORY } from "./store-reads.js";
import { foreignMutations, localName, vuexStores, type Module } from "./vuex.js";

/**
 * Vuex state a component watches and a mutation writes. A watcher's read names the path from the root state
 * (`clubs.list`: `'$store.state.clubs.list'`, `mapState('clubs', ['list'])`, `store.state.clubs.list` through
 * `useStore()` — `FileAnalysis.storeWatch.watchers`, factory `$vuex`); a mutation's write names the path below its own
 * module's state (`list`, `FileAnalysis.storeWatch.stateWrites`). The module's place in the root store — the namespace
 * its registration spells, which is also where its state sits — joins the two: a mutation of `clubs` writing `list`
 * runs the watcher of `clubs.list`, never the one of a `list` another module holds, and a module nobody registers
 * writes nothing anyone watches. Where several root stores exist, the one the watcher's app mounts decides.
 *
 * Links are INFERRED `dispatch` from the mutation function to the watcher callback (`dispatch:vuex-state-watch`),
 * `callName` the member written. A push into a list or a `Map.set` watched without `deep` runs nothing in Vue, so it stays
 * unjoined, as for every other reactive cell.
 *
 * `dispatch:vuex-state-watch`. A mutation's first parameter is its module's state, and `state.x = v`,
 * `state.x.push(c)`, `state.byId.set(k, c)`, `Object.assign(state.filters, p)` and `Vue.set(state.byId, k, c)` are
 * `storeWatch.stateWrites` (paths below the module; `deep` or a computed that uses the member reads it through), read
 * through `store.state.clubs.list` via `useStore()` from `vuex`. A store with no `modules:` is a root
 * (`StoreShapes.root`: the file calls `createStore({…})` / `new Vuex.Store({…})` with Vuex imported); a mutation
 * written in a file other than its module's (a helper several modules import) belongs only to the modules whose table
 * spreads, merges or builds from it (`foreignMutations`).
 *
 * State watchers (`$store.state…`, `useStore().state`, `this.$watch('$store.state…')`) join the mutations that write
 * that state, and a component's write to store state (`store.x =`) is a store write. State watched in code:
 * `this.$watch('$store.state.clubs.list', cb)`, `store.watch((state) => state.clubs.list, cb)` on `this.$store` /
 * `useStore()` / a project-imported store, a Composition `mapState` bound to a store
 * (`computed(mapped.list.bind({ $store: store }))`) watched through `watch(list, cb)` (`withVuexCalls`); a getter —
 * `watch(() => store.getters['clubs/total'], cb)` reads `@getter:clubs/total`, resolved to the state the getter reads
 * (`storeWatch.getterReads`, module-relative) under the module the key names. An Options computed reading
 * `this.$store.getters.total` / `['clubs/total']` and a `...mapGetters('clubs', ['total'])` /
 * `mapGetters({ n: 'clubs/total' })` entry read the same key; a getter that reads other getters (`getters.total`,
 * resolved in its own module's namespace), `rootState` (absolute state paths) or `rootGetters['season/year']` reads
 * what those read (`getterReads[].getters` / `rootPaths` / `rootGetters`, up to 24 getters deep, a cycle once). A
 * bare key (`store.getters.standings`) names the getter of a module that is not `namespaced`, answered only when
 * exactly one such getter of the store has it, the root store's own first. A Vue ref can stand for another cell; a
 * project composable's computed watched in another file joins the composable functions that write it.
 * `toSignal(…pipe(cb))` listens to an Angular subject (see subject-flows.ts).
 */
export class VuexStateWatchResolver implements DispatchResolver {
  readonly id = "vuex-state-watch";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 32;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const watching = analyses.filter((a) => a.storeWatch?.watchers?.some((w) => w.reads.some((r) => r.factory === VUEX_FACTORY)));
    const writing = analyses.filter((a) => a.storeWatch?.stateWrites?.length);
    if (watching.length === 0 || writing.length === 0) return [];
    const stores = vuexStores(analyses);
    if (!stores) return [];
    const { roots, registered, filesOf, ownerOf, preferred, trees } = stores;
    // The first names of the modules each root registers: the root's own `Object.assign(state, …)` never writes below them.
    const moduleHeads = new Map<FileAnalysis, Set<string>>(roots.map((r) => [r, new Set([...(trees.get(r)?.keys() ?? [])].map((ns) => ns.split("/")[0]!))]));
    // Where each file's mutations write: the root store it belongs to and the state path of its module.
    const placesOf = (file: FileAnalysis): Array<{ root: FileAnalysis; prefix: string }> => {
      const out = (ownerOf.get(file.filePath) ?? []).map(({ root, ns }) => ({ root, prefix: ns.split("/").join(".") }));
      // The root store's own mutations (`createStore({ state, mutations })`, or a file it imports that no module registers).
      for (const root of roots) {
        if (registered.has(file.filePath) || out.some((o) => o.root === root)) continue;
        if (filesOf(root).includes(file)) out.push({ root, prefix: "" });
      }
      return out;
    };
    // Whether a mutation written in `file` belongs to the module: its own file, a `mutations` table of an imported file, or a
    // table the module's own spreads / factory name — never a helper the module merely imports beside others that do too.
    const foreign = new Map<string, ReturnType<typeof foreignMutations>>();
    const holds = (root: FileAnalysis, prefix: string, file: FileAnalysis, fn: string): boolean => {
      const mod: Module | undefined = prefix ? trees.get(root)?.get(prefix.split(".").join("/")) : { file: root, exported: "default" };
      if (!mod || mod.file === file) return true;
      const table = fn.includes(".") ? fn.slice(0, fn.lastIndexOf(".")) : "";
      if (/(?:^|\.)mutations$/.test(table)) return true;
      const key = `${root.filePath}\0${prefix}`;
      let own = foreign.get(key);
      if (!own) foreign.set(key, (own = foreignMutations(stores, mod)));
      return own.tables.has(`${file.filePath}\0${table}`) || own.fns.has(`${file.filePath}\0${fn}`);
    };
    // Whether a module declares `namespaced: true`: only then do its getters answer under its name.
    const isNamespaced = (m: Module): boolean => !!m.file.storeShapes?.namespaced?.some((n) => n === m.exported || n === localName(m.file, m.exported));
    // The namespace a module's getters answer under: the registered names of itself and its parents that are namespaced.
    const effectiveNs = (root: FileAnalysis, ns: string): string => {
      const segments = ns.split("/");
      const out: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        const m = trees.get(root)?.get(segments.slice(0, i + 1).join("/"));
        if (m && isNamespaced(m)) out.push(segments[i]!);
      }
      return out.join("/");
    };
    // The state paths a getter reads under one root store, from the root state: what it reads of its own module's state,
    // of `rootState`, and what the getters it reads (`getters.total`, `rootGetters['season/year']`) read in turn.
    type GetterRead = NonNullable<NonNullable<FileAnalysis["storeWatch"]>["getterReads"]>[number];
    const getterPaths = (root: FileAnalysis, key: string, seen: Set<string>): string[] => {
      if (seen.has(key) || seen.size > 24) return [];
      seen.add(key);
      const parts = key.split("/").filter(Boolean);
      const name = parts.pop();
      if (!name) return [];
      const where = parts.join("/");
      type Match = { g: GetterRead; ns: string; eff: string };
      const legacy: Match[] = [];
      const effective: Match[] = [];
      const collect = (mod: Module, ns: string, into: Match[]): void => {
        for (const f of filesOf(mod.file)) {
          if (f !== mod.file && registered.has(f.filePath)) continue;
          for (const g of f.storeWatch?.getterReads ?? []) {
            if (g.name !== name || (f !== mod.file && g.table !== "getters")) continue;
            into.push({ g, ns, eff: effectiveNs(root, ns) });
          }
        }
      };
      // The registered path as the namespace (a module that is not namespaced answers by it too) and the root's own getters;
      // else a module that is not namespaced under its bare name, when exactly one getter of the store has it.
      if (where === "") collect({ file: root, exported: "default" }, "", legacy);
      else {
        const mod = trees.get(root)?.get(where);
        if (mod) collect(mod, where, legacy);
      }
      for (const [ns, mod] of trees.get(root) ?? []) {
        if (effectiveNs(root, ns) === where && ns !== where) collect(mod, ns, effective);
      }
      const kept = effective.length === 1 && legacy.length === 0 ? effective : legacy;
      const out: string[] = [];
      for (const { g, ns, eff } of kept) {
        const prefix = ns.split("/").join(".");
        for (const p of g.paths) out.push(prefix ? `${prefix}.${p}` : p);
        for (const local of g.getters ?? []) out.push(...getterPaths(root, eff ? `${eff}/${local}` : local, seen));
        out.push(...(g.rootPaths ?? []));
        for (const rg of g.rootGetters ?? []) out.push(...getterPaths(root, rg, seen));
      }
      return out;
    };
    const pathsOf = (read: string, root: FileAnalysis): string[] => (read.startsWith(GETTER_READ) ? getterPaths(root, read.slice(GETTER_READ.length), new Set()) : [read]);
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const file of writing) {
      const places = placesOf(file);
      if (places.length === 0) continue;
      for (const a of watching) {
        const rootsOfApp = roots.length === 1 ? roots : preferred(a.filePath);
        if (rootsOfApp.length === 0) continue;
        const functions = [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
        for (const w of a.storeWatch!.watchers!) {
          const target = functions.find((f) => f.name === w.function);
          if (!target) continue;
          for (const read of w.reads) {
            if (read.factory !== VUEX_FACTORY) continue;
            for (const write of file.storeWatch!.stateWrites!) {
              if (w.truthyOnly && write.falsy) continue;
              if (file === a && write.function === w.function) continue;
              for (const place of places) {
                if (!rootsOfApp.includes(place.root) || !holds(place.root, place.prefix, file, write.function)) continue;
                const written = place.prefix ? (write.path ? `${place.prefix}.${write.path}` : place.prefix) : write.path;
                // A write of members the file cannot name (`""`) meets any read in or around the module.
                const meets = pathsOf(read.path, place.root).some((readPath) => (written !== "" ? sameCell(`s:${written}`, `s:${readPath}`) : !moduleHeads.get(place.root)?.has(readPath.replace(/\*$/, "").split(".")[0]!)));
                if (!meets) continue;
                const id = `${file.filePath}\0${write.function}\0${write.line}\0${a.filePath}\0${w.function}`;
                if (seen.has(id)) continue;
                seen.add(id);
                links.push({
                  sourceFile: file.filePath,
                  sourceSymbol: write.function,
                  sourceLine: write.line,
                  callName: write.spelling || read.path.replace(/\*$/, "").replace(GETTER_READ, ""),
                  targetFile: a.filePath,
                  targetSymbol: w.function,
                  targetLine: target.line,
                  confidence: "INFERRED",
                });
              }
            }
          }
        }
      }
    }
    return links;
  }
}
