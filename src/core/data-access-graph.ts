import type {
  FileAnalysis,
  DataAccessGraph,
  DataAccessNode,
  DataAccessEdge,
} from "../types/analysis.js";

/**
 * Build the project-wide data-access graph rendered in the Architecture
 * tab's "Data Access" mode.
 *
 * Nodes:
 *   - One "file" node per source file that performs at least one DB call.
 *   - One "datastore" node per unique `dataSource.target` across all files,
 *     produced by the import-index enrichment pass (e.g. `@prisma/client`,
 *     `Microsoft.EntityFrameworkCore`, `../lib/prisma`). DB calls with a
 *     null target are bucketed under a single `unknown` datastore so they
 *     don't disappear from the view entirely.
 *
 * Edges: one edge per (file, target) pair, carrying the individual call
 * sites so the UI can render `prisma.user.findMany @ line 7` detail.
 *
 * Only data sources with `kind === "database"` participate — `state`,
 * `api-call`, `env`, etc. are not data accesses in the storage sense.
 */
const UNKNOWN_TARGET = "(unresolved)";

export function buildDataAccessGraph(analyses: FileAnalysis[]): DataAccessGraph {
  const nodes = new Map<string, DataAccessNode>();
  const edges = new Map<string /* "src→tgt" */, DataAccessEdge>();

  function ensureFile(filePath: string): string {
    const id = `file::${filePath}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        name: fileBasename(filePath),
        kind: "file",
        filePath,
        inboundCount: 0,
        outboundCount: 0,
      });
    }
    return id;
  }

  function ensureDatastore(target: string): string {
    const id = `db::${target}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        name: target,
        kind: "datastore",
        filePath: "",
        inboundCount: 0,
        outboundCount: 0,
      });
    }
    return id;
  }

  for (const a of analyses) {
    for (const ds of a.dataSources ?? []) {
      if (ds.kind !== "database") continue;
      const target = ds.target && ds.target.trim() !== "" ? ds.target : UNKNOWN_TARGET;
      const srcId = ensureFile(a.filePath);
      const tgtId = ensureDatastore(target);

      const key = `${srcId}→${tgtId}`;
      let edge = edges.get(key);
      if (!edge) {
        edge = { source: srcId, target: tgtId, calls: [], total: 0 };
        edges.set(key, edge);
      }
      edge.calls.push({ name: ds.name, line: ds.line });
      edge.total += 1;
    }
  }

  for (const edge of edges.values()) {
    const src = nodes.get(edge.source);
    const tgt = nodes.get(edge.target);
    if (src) src.outboundCount += edge.total;
    if (tgt) tgt.inboundCount += edge.total;
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort(
      (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
    ),
  };
}

function fileBasename(p: string): string {
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash >= 0 ? p.slice(slash + 1) : p;
}
