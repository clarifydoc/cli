import type { ExportGraph } from "./graph-model.js";
import { routeChains } from "./mermaid.js";
import type { Summary } from "./types.js";
import { csvCell } from "./text.js";

/**
 * CSV tables for a spreadsheet or a BI tool: the route inventory, the entity
 * inventory, and every graph as a node table plus an edge table — the two
 * files Gephi's spreadsheet import, and most graph tools, take. A list inside
 * a field is `; `-joined. Rows keep the order the analysis has them in.
 */

function table(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const unique = (items: string[]) => [...new Set(items)];

/** Every route, frontend and API, with who calls it and what it reaches. */
export function routesCsv(summary: Summary): string {
  const chains = new Map(routeChains(summary).map((c) => [c.key, c]));
  const projects = summary.fileProjects ?? {};
  return table(
    ["kind", "method", "path", "handler", "file", "line", "project", "guards", "callers", "caller_files", "reaches"],
    (summary.routeMap ?? []).map((r) => {
      const chain = chains.get(`${r.filePath ?? ""}|${`${r.httpMethod ?? ""} ${r.path}`.trim()}`);
      return [
        r.kind,
        r.httpMethod ?? "",
        r.path,
        r.handler ?? "",
        r.filePath ?? "",
        r.line,
        r.filePath ? (projects[r.filePath] ?? "") : "",
        (r.middleware ?? []).join("; "),
        chain?.callers.length ?? 0,
        unique((chain?.callers ?? []).map((c) => c.file)).join("; "),
        unique((chain?.effects ?? []).map((e) => `${e.effect} ${e.resource}`)).join("; "),
      ];
    }),
  );
}

/** Every entity with its columns, relations, and the functions that reach it. */
export function entitiesCsv(summary: Summary): string {
  const nodes = summary.entityGraph?.nodes ?? [];
  const edges = summary.entityGraph?.edges ?? [];
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  const access = summary.symbolDataAccess ?? [];
  const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route");
  return table(
    ["name", "kind", "orm", "file", "line", "columns", "primary_key", "related", "accessed_by", "routes_reaching"],
    nodes.map((n) => {
      const related = edges.filter((e) => e.source === n.id || e.target === n.id).map((e) => nameOf.get(e.source === n.id ? e.target : e.source) ?? "");
      const by = access.filter((a) => a.entity === n.name);
      const lower = n.name.toLowerCase();
      return [
        n.name,
        n.kind,
        n.orm ?? "",
        n.filePath,
        n.line ?? "",
        n.columns?.length ?? 0,
        (n.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name).join("; "),
        unique(related.filter(Boolean)).join("; "),
        unique(by.map((a) => `${a.file}:${a.symbolLine} ${a.symbol}`)).join("; "),
        unique(flows.filter((f) => f.resource.toLowerCase() === lower).map((f) => f.entryLabel)).length,
      ];
    }),
  );
}

/** The attribute names a list of rows carries, in first-seen order. */
function attrKeys(rows: Array<{ attrs: Record<string, unknown> }>): string[] {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.attrs)) keys.add(key);
  return [...keys];
}

/** A graph's nodes: `id`, `label`, `type`, then every attribute any node has. */
export function graphNodesCsv(graph: ExportGraph): string {
  const keys = attrKeys(graph.nodes);
  return table(["id", "label", "type", ...keys], graph.nodes.map((n) => [n.id, n.label, n.type, ...keys.map((k) => n.attrs[k] ?? "")]));
}

/** A graph's edges: `source`, `target`, `type` (Gephi reads `Directed`/`Undirected` there), `relation`, then the attributes. */
export function graphEdgesCsv(graph: ExportGraph): string {
  const keys = attrKeys(graph.edges);
  const type = graph.directed ? "Directed" : "Undirected";
  return table(["source", "target", "type", "relation", ...keys], graph.edges.map((e) => [e.source, e.target, type, e.relation, ...keys.map((k) => e.attrs[k] ?? "")]));
}
