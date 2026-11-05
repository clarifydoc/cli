import type { FileAnalysis } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import {
  FAST_ENDPOINT_FACT,
  FAST_GROUP_FACT,
  FAST_GROUP_MARK,
  FAST_PREFIX_FACT,
  type FastEndpointFact,
  type FastGroupFact,
  type FastPrefixFact,
} from "./fast-endpoints.js";

/**
 * FastEndpoints routes carry two prefixes no endpoint file states: the group class's (`Group<ClubsGroup>()` +
 * `class ClubsGroup : Group { Configure("clubs", …) }`) and the global `Endpoints.RoutePrefix = "api"` set where
 * `UseFastEndpoints` is called (outermost, unless the endpoint opts out with `DontAddRoutePrefix()`).
 * A group two classes share the name of stays unresolved; a global prefix wins only when the endpoint's own
 * sub-project sets one, else when every sub-project that sets one agrees.
 */
export const fastEndpointPrefixes: RouteResolver = {
  id: "fast-endpoint-prefixes",
  languages: ["csharp"],
  priority: 26,
  resolve(analyses: FileAnalysis[]): void {
    const groups = new Map<string, Array<{ prefix: string; projectId?: string }>>();
    const globals: Array<{ prefix: string; projectId?: string }> = [];
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === FAST_GROUP_FACT && f.owner) (groups.get(f.owner) ?? groups.set(f.owner, []).get(f.owner)!).push({ prefix: (f.data as FastGroupFact).prefix, projectId: a.projectId });
        else if (f.kind === FAST_PREFIX_FACT) globals.push({ prefix: (f.data as FastPrefixFact).prefix, projectId: a.projectId });
      }
    }
    if (groups.size === 0 && globals.length === 0) return;
    const globalFor = (projectId: string | undefined): string => {
      const own = globals.filter((g) => g.projectId === projectId);
      const pool = own.length > 0 ? own : globals;
      return new Set(pool.map((g) => g.prefix)).size === 1 ? pool[0]!.prefix : "";
    };
    for (const a of analyses) {
      const endpoints = (a.routeFacts ?? []).filter((f) => f.kind === FAST_ENDPOINT_FACT && f.owner);
      if (endpoints.length === 0) continue;
      a.routes = a.routes.map((r) => {
        const fact = endpoints.find((f) => f.owner === r.owner && (f.data as FastEndpointFact).line === r.line);
        if (!fact || r.kind !== "api") return r;
        const { group, dontPrefix } = fact.data as FastEndpointFact;
        let groupPrefix = "";
        if (group) {
          const all = groups.get(group) ?? [];
          const own = all.filter((g) => g.projectId === a.projectId);
          const pick = own.length > 0 ? own : all;
          if (pick.length !== 1) return r;
          groupPrefix = pick[0]!.prefix;
        }
        const global = dontPrefix ? "" : globalFor(a.projectId);
        if (!groupPrefix && !global && !r.prefixUnresolved?.startsWith(FAST_GROUP_MARK)) return r;
        const { prefixUnresolved: _, ...rest } = r;
        const path = "/" + [global, groupPrefix, r.path].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
        return { ...rest, path };
      });
    }
  },
};
