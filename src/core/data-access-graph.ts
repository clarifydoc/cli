import type {
  FileAnalysis,
  DataAccessGraph,
  DataAccessNode,
  DataAccessEdge,
  EntityGraph,
  SymbolDataAccess,
} from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
// One shared key derivation with the ER-graph node dedupe — an access name
// must reach the same node `synthesizeReferencedTableEntities` deduped against.
import { nodeKeyIndex, tableMatchKeys as entityMatchKeys } from "./entity-graph.js";

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
/** Sentinel datastore/queue name for DB-shaped calls whose target could not be resolved. */
export const UNKNOWN_TARGET = "(unresolved)";

/**
 * Build the file → datastore/entity/queue graph described in the module comment.
 *
 * @param analyses - Every file analysis; only database and queue data sources
 *   contribute
 * @returns Nodes and edges with their in/out counts, in a stable order
 */
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

  function ensureEntity(target: string, entity: string): string {
    const id = `entity::${target}::${entity}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        name: entity,
        kind: "entity",
        filePath: "",
        inboundCount: 0,
        outboundCount: 0,
      });
    }
    return id;
  }

  function ensureQueue(target: string): string {
    const id = `queue::${target}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        name: target,
        kind: "queue",
        filePath: "",
        inboundCount: 0,
        outboundCount: 0,
      });
    }
    return id;
  }

  function edgeFor(source: string, target: string): DataAccessEdge {
    const key = `${source}→${target}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = { source, target, calls: [], total: 0 };
      edges.set(key, edge);
    }
    return edge;
  }

  for (const a of analyses) {
    for (const ds of a.dataSources ?? []) {
      if (ds.kind === "queue-publish" || ds.kind === "queue-consume") {
        // Broker destinations are shared rendezvous nodes: a publisher file and
        // a consumer file that name the same exchange/queue/topic meet at one
        // queue node, and edge direction carries the message flow —
        // file→queue for publish, queue→file for consume.
        const qTarget = ds.target && ds.target.trim() !== "" ? ds.target.trim() : UNKNOWN_TARGET;
        const fileId = ensureFile(a.filePath);
        const qId = ensureQueue(qTarget);
        const edge = ds.kind === "queue-publish" ? edgeFor(fileId, qId) : edgeFor(qId, fileId);
        edge.calls.push({ name: ds.name, line: ds.line, ...(ds.entity ? { entity: ds.entity } : {}) });
        edge.total += 1;
        continue;
      }
      if (ds.kind !== "database") continue;
      const target = ds.target && ds.target.trim() !== "" ? ds.target : UNKNOWN_TARGET;
      const srcId = ensureFile(a.filePath);
      const dsId = ensureDatastore(target);

      if (ds.entity && ds.entity.trim() !== "") {
        // Three-tier: file → entity → datastore. The call sites live on the
        // file→entity edge; the entity→datastore edge is a thin grouping link.
        const entId = ensureEntity(target, ds.entity);
        const fe = edgeFor(srcId, entId);
        fe.calls.push({ name: ds.name, line: ds.line, entity: ds.entity });
        fe.total += 1;
        edgeFor(entId, dsId).total += 1;
      } else {
        const fd = edgeFor(srcId, dsId);
        fd.calls.push({ name: ds.name, line: ds.line });
        fd.total += 1;
      }
    }
  }

  for (const edge of edges.values()) {
    const src = nodes.get(edge.source);
    const tgt = nodes.get(edge.target);
    if (src) src.outboundCount += edge.total;
    if (tgt) tgt.inboundCount += edge.total;
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => byOrdinal(a.id, b.id)),
    edges: [...edges.values()].sort(
      (a, b) => byOrdinal(a.source, b.source) || byOrdinal(a.target, b.target),
    ),
  };
}

/** The last path segment, for either separator. */
function fileBasename(p: string): string {
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash >= 0 ? p.slice(slash + 1) : p;
}

/** Match keys for an entity name: lowercased bare name + a de-pluralized form. */
/**
 * Attribute each database access to the function/method that contains it,
 * producing the symbol↔entity bridge between the Call Traces view and the
 * Data Model. Direct attribution only — a function is recorded for an entity
 * solely where the DB call literally occurs in its body (no transitive
 * propagation to callers).
 *
 * The entity name (`ds.entity`, already resolved by the data-source enrichment
 * pass) is matched case-insensitively — with a singular/plural fallback —
 * against `entityGraph` node names so the reverse "Accessed by" view on an
 * entity can key on the canonical name. Unmatched DB targets still surface as
 * forward badges on the trace (they are real accesses), but carry
 * `entityMatched: false`.
 *
 * Symbol names mirror the call-graph convention (`fn.name` for top-level
 * functions, `Class.method` for methods) so the keys line up with
 * `SymbolLink.sourceSymbol` and light up the existing trace index. A call
 * outside any function belongs to the file's `<setup>` when the plugin made
 * one (module-level code), and is dropped otherwise.
 */
/** Raw entity name → the ER node it matches (case-insensitive, singular/plural), else null. */
export function entityMatcher(entityGraph: EntityGraph): (raw: string) => string | null {
  const entityByKey = nodeKeyIndex(entityGraph.nodes, (n) => n.name);
  return (raw) => {
    for (const k of entityMatchKeys(raw)) {
      const hit = entityByKey.get(k);
      if (hit) return hit;
    }
    return null;
  };
}

export function attributeDataAccessToSymbols(
  analyses: FileAnalysis[],
  entityGraph: EntityGraph,
): SymbolDataAccess[] {
  // Canonical entity lookup: match key → ER node name.
  const entityByKey = nodeKeyIndex(entityGraph.nodes, (n) => n.name);
  const matchEntity = (raw: string): string | null => {
    for (const k of entityMatchKeys(raw)) {
      const hit = entityByKey.get(k);
      if (hit) return hit;
    }
    return null;
  };

  // (file::symbol::entity) → merged record.
  const merged = new Map<string, SymbolDataAccess>();

  for (const a of analyses) {
    // Index every function/method by line span. Methods are qualified
    // `Class.method`; top-level functions keep their bare name.
    const fns: Array<{ symbol: string; line: number; endLine: number }> = [];
    for (const fn of a.functions ?? []) {
      fns.push({ symbol: fn.name, line: fn.line, endLine: fn.endLine });
    }
    for (const cls of a.classes ?? []) {
      for (const m of cls.methods ?? []) {
        fns.push({ symbol: `${cls.name}.${m.name}`, line: m.line, endLine: m.endLine });
      }
    }
    // An inline route handler (`app.get("/x", async (req, res) => …)`) is no
    // function, but its calls are the route's own, line by line: an access on
    // one of those lines belongs to the route's `route:<METHOD> <path>`
    // symbol — the anchor the symbol linker mints and the reach pass starts from.
    const inlineRouteAt = new Map<number, { symbol: string; line: number; named: boolean }>();
    for (const r of a.routes ?? []) {
      for (const c of r.calls ?? []) {
        if (typeof c.line === "number" && !inlineRouteAt.has(c.line)) {
          inlineRouteAt.set(c.line, { symbol: `route:${r.httpMethod ?? "USE"} ${r.path}`, line: r.line, named: !!r.handler });
        }
      }
    }
    if (fns.length === 0 && inlineRouteAt.size === 0 && (a.classes ?? []).length === 0) continue;
    const setupFn = (a.functions ?? []).find((f) => f.name === "<setup>");
    const setup = setupFn ? { symbol: "<setup>", line: setupFn.line } : null;

    for (const ds of a.dataSources ?? []) {
      const isQueue = ds.kind === "queue-publish" || ds.kind === "queue-consume";
      if (ds.kind !== "database" && !isQueue) continue;
      // Innermost (smallest-span) function whose body contains the call line.
      let best: { symbol: string; line: number } | null = null;
      let bestSpan = Infinity;
      for (const f of fns) {
        if (ds.line >= f.line && ds.line <= f.endLine) {
          const span = f.endLine - f.line;
          if (span < bestSpan) {
            bestSpan = span;
            best = { symbol: f.symbol, line: f.line };
          }
        }
      }
      // Only the file's top-level `<setup>` contains it (or nothing does): a class body stating it
      // (`queryset = Club.objects.all()` on a viewset) is the class's own; an inline route
      // handler's call on that line is the better owner too.
      if (!best || best.symbol === "<setup>") {
        const cls = (a.classes ?? []).filter((c) => c.endLine !== undefined && ds.line >= c.line && ds.line <= c.endLine).sort((x, y) => (x.endLine! - x.line) - (y.endLine! - y.line))[0];
        if (cls) best = { symbol: cls.name, line: cls.line };
      }
      // An inline route handler registered inside the function (`app.MapGet("/kits", async (db) => …)`
      // in a `MapLeagueApi` method) is narrower than it: the access is that route's own.
      const inline = inlineRouteAt.get(ds.line);
      if (inline && (!best || best.symbol === "<setup>" || (!inline.named && inline.line >= best.line))) best = inline;
      // Module-level code (a `new Worker("q", async (job) => …)` at the top of
      // the file) is the file's `<setup>`, the symbol the call graph gives it.
      if (!best && setup) best = setup;
      // A registration naming the handler that runs (`DataSourceInfo.handler`): that handler's.
      const named = ds.handler ? fns.find((f) => f.symbol === ds.handler) : undefined;
      if (named) best = { symbol: named.symbol, line: named.line };
      if (!best) continue;

      const raw = (ds.entity ?? "").trim();
      const matchedName = raw && !isQueue ? matchEntity(raw) : null;
      // Queue ops don't join the ER model; the "entity" is the routing key /
      // message type, falling back to the destination so a publish with only
      // an exchange name still reaches the trace.
      const entity = matchedName ?? raw ?? "";
      const datastore = ds.target && ds.target.trim() !== "" ? ds.target.trim() : null;
      // A stored-procedure call names no entity; the routine is what the trace
      // reaches (unmatched, like any table the ER model does not know). So is a
      // store without tables (a Redis cache).
      const traceEntity = entity || (isQueue || ds.routine || ds.store ? (datastore ?? "") : "");
      if (!traceEntity) continue; // no resolvable target — nothing to link.

      const key = `${a.filePath}::${best.symbol}::${ds.kind}::${traceEntity}`;
      let rec = merged.get(key);
      if (!rec) {
        rec = {
          file: a.filePath,
          symbol: best.symbol,
          symbolLine: best.line,
          entity: traceEntity,
          entityMatched: matchedName !== null,
          datastore,
          ...(isQueue ? { access: ds.kind as "queue-publish" | "queue-consume" } : {}),
          sites: [],
        };
        merged.set(key, rec);
      }
      rec.sites.push({ name: ds.name, line: ds.line });
      if (!rec.datastore && datastore) rec.datastore = datastore;
    }
  }

  const out = [...merged.values()];
  for (const r of out) r.sites.sort((x, y) => x.line - y.line);
  out.sort(
    (a, b) =>
      byOrdinal(a.file, b.file) ||
      byOrdinal(a.symbol, b.symbol) ||
      byOrdinal(a.entity, b.entity),
  );
  return out;
}
