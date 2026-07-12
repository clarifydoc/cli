import type { FileAnalysis, SymbolLink } from "../../types/analysis.js";
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
    if (subset.length > 0) out.push(...r.resolve(subset));
  }
  return out;
}

export type { DispatchResolver } from "./base.js";
