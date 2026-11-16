import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { sameCell } from "../../../core/reactive-triggers.js";
import { VUEX_FACTORY } from "./store-reads.js";
import { vuexStores } from "./vuex.js";

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
                if (!rootsOfApp.includes(place.root)) continue;
                const written = place.prefix ? (write.path ? `${place.prefix}.${write.path}` : place.prefix) : write.path;
                // A write of members the file cannot name (`""`) meets any read in or around the module.
                if (written !== "" ? !sameCell(`s:${written}`, `s:${read.path}`) : moduleHeads.get(place.root)?.has(read.path.replace(/\*$/, "").split(".")[0]!)) continue;
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
