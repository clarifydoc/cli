import type { FileAnalysis, SymbolLink } from "../../types/analysis.js";
import type { DispatchResolver } from "./base.js";
import { CSharpMediatrResolver } from "../plugins/csharp/dispatch.js";

/** All registered dispatch-indirection resolvers (one per language pattern). */
const resolvers: DispatchResolver[] = [new CSharpMediatrResolver()];

/**
 * Run every dispatch resolver over the project and return the synthetic
 * caller→handler symbol links they find. Each resolver only sees analyses for
 * its own languages; core never names a framework itself (mirrors
 * `reconcileProjectEntities`).
 */
export function resolveProjectDispatch(analyses: FileAnalysis[]): SymbolLink[] {
  const out: SymbolLink[] = [];
  for (const r of resolvers) {
    const langs = new Set(r.languages);
    const subset = analyses.filter((a) => langs.has(a.language));
    if (subset.length > 0) out.push(...r.resolve(subset));
  }
  return out;
}

export type { DispatchResolver } from "./base.js";
