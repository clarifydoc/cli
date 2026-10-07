import type { FileAnalysis, RouteInfo } from "../../types/analysis.js";
import type { ProjectContext } from "../../types/project.js";
import type { RouteResolver } from "./base.js";
import { allPluginMetas } from "../registry.js";

/**
 * Run every plugin-contributed route resolver (`meta.routeResolvers`) over the
 * project, in priority order, each on the analyses of its own languages. Runs
 * before router mounts are applied, so a resolver may emit `mount: true` rows
 * for the generic mount pass to compose. In-memory: per-file JSON on disk keeps
 * what the extractor saw. Returns how many rows the resolvers created or
 * rewrote.
 */
export function reconcileProjectRoutes(
  analyses: FileAnalysis[],
  ctx: ProjectContext,
  registered: readonly RouteResolver[] = registeredRouteResolvers(),
): number {
  const resolvers = [...registered];
  if (resolvers.length === 0) return 0;
  resolvers.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let touched = 0;
  for (const r of resolvers) {
    const langs = new Set(r.languages);
    const subset = analyses.filter((a) => langs.has(a.language));
    if (subset.length === 0) continue;
    const before = new Set<RouteInfo>(subset.flatMap((a) => a.routes));
    r.resolve(subset, ctx);
    for (const a of subset) {
      for (const route of a.routes) {
        if (before.has(route)) continue;
        route.resolvedBy ??= r.id;
        touched++;
      }
    }
  }
  return touched;
}

/** Every plugin's `routeResolvers`, each once (family plugins share instances across metas). */
function registeredRouteResolvers(): RouteResolver[] {
  const out: RouteResolver[] = [];
  const seen = new Set<RouteResolver>();
  for (const meta of allPluginMetas()) {
    for (const r of meta.routeResolvers ?? []) {
      if (seen.has(r)) continue;
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

export type { RouteResolver } from "./base.js";
