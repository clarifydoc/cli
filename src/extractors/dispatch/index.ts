import { relationForStrategy, type FileAnalysis, type SymbolLink } from "../../types/analysis.js";
import type { DispatchResolver } from "./base.js";
import { allPluginMetas } from "../registry.js";

/**
 * Run every plugin-contributed dispatch resolver (`meta.dispatchResolvers`)
 * over the project and return the synthetic caller→handler symbol links they
 * find. Each resolver only sees analyses for its own languages; core never
 * names a framework itself (mirrors `reconcileProjectEntities`). Resolvers run
 * in `priority` order so the emitted link order is stable regardless of which
 * plugin meta carries a resolver.
 */
export function resolveProjectDispatch(analyses: FileAnalysis[]): SymbolLink[] {
  const resolvers: DispatchResolver[] = [];
  const seen = new Set<DispatchResolver>();
  for (const meta of allPluginMetas()) {
    for (const r of meta.dispatchResolvers ?? []) {
      if (seen.has(r)) continue;
      seen.add(r);
      resolvers.push(r);
    }
  }
  resolvers.sort((a, b) => a.priority - b.priority);

  const out: SymbolLink[] = [];
  for (const r of resolvers) {
    const langs = new Set(r.languages);
    const subset = analyses.filter((a) => langs.has(a.language));
    if (subset.length === 0) continue;
    // Stamp provenance here rather than in each resolver. A resolver emits from
    // several places (the WebFlow one has four), so asking each to remember the
    // tag means ten chances to forget it and a silent `undefined` in the
    // artifact when someone adds an eleventh. The runner is the one place that
    // knows both the resolver and everything it produced.
    const strategy = `dispatch:${r.id}` as const;
    const relation = relationForStrategy(strategy);
    for (const link of r.resolve(subset)) {
      out.push({ ...link, strategy, relation });
    }
  }
  return out;
}

export type { DispatchResolver } from "./base.js";
