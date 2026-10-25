import type { FileAnalysis } from "../types/analysis.js";
import type { ProjectRouteBase } from "./config-values.js";

/**
 * Put each sub-project's configured route base (a servlet context path, a
 * reactive base path) in front of the API routes it serves, so a route carries
 * the path a caller requests. Only complete paths: a row whose outer prefix is
 * unknown (`prefixUnresolved`) keeps its tail, since the base sits in front of
 * the part nobody knows. Project-level + in-memory, after router mounts compose
 * and before the symbol linker anchors routes. Returns the rows prefixed.
 */
export function applyRouteBases(analyses: FileAnalysis[], bases: ReadonlyMap<string, ProjectRouteBase[]>): number {
  if (bases.size === 0) return 0;
  let n = 0;
  for (const a of analyses) {
    const list = bases.get(a.projectId ?? "root");
    const base = list?.find((b) => b.languages.has(a.language))?.base;
    if (!base || a.routes.length === 0) continue;
    a.routes = a.routes.map((r) => {
      if (r.kind !== "api" || r.prefixUnresolved || r.basePath || r.mount) return r;
      n++;
      return {
        ...r,
        path: joinBase(base.path, r.path),
        ...(r.aliases ? { aliases: r.aliases.map((p) => joinBase(base.path, p)) } : {}),
        basePath: { path: base.path, key: base.key, file: base.file },
      };
    });
  }
  return n;
}

/** `/league` + `/clubs/{id}` → `/league/clubs/{id}`; `/league` + `/` → `/league`. */
export function joinBase(base: string, path: string): string {
  const tail = path.startsWith("/") ? path : `/${path}`;
  return tail === "/" ? base : base + tail;
}
