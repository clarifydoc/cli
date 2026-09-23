/** Data-tier tools: the ER model and route/screen → data-effect flows. */

import type { McpTool } from "../protocol.js";
import { byOrdinal } from "../../core/ordinal.js";
import type { DataFlowPath, EntityGraphEdge, EntityGraphNode } from "../../types/analysis.js";
import {
  bulletList,
  cap,
  confidenceNote,
  contains,
  countMap,
  enumArg,
  facts,
  joinLines,
  loc,
  numberArg,
  plural,
  section,
  stringArg,
  tally,
} from "../format.js";
import { requireAnalysis, stalenessHint, type ToolContext } from "./context.js";
import { filterToDrop, missHeadline, noResults, type DroppableFilter } from "../empty.js";

export function dataModelTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_data_model",
    title: "Entities, tables and relations",
    description:
      "The extracted data model: ORM entities / SQL tables with their columns, keys and relationships " +
      "(crow's-foot cardinality, foreign keys, join tables), plus which functions read or write each one. Call " +
      "without `entity` for the inventory, then name an entity for its columns, relations and accessors. " +
      "Each row's `orm` says where it came from and how far to trust it: a named ORM or `sql` is declared " +
      "schema; `dfm` is reconstructed from a Delphi form's dataset SQL and persistent fields; `inferred` is a " +
      "table seen only in a query, so it has a name but no columns.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity/table name (case-insensitive) to describe in full." },
        query: { type: "string", description: "Substring filter for the inventory listing." },
        limit: { type: "number", description: "Max rows per list (default 30)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary, index } = loaded;
      const graph = summary.entityGraph;
      const limit = numberArg(args, "limit", 30, { max: 300 });
      if (!graph || graph.nodes.length === 0) {
        return {
          text: noResults({
            headline:
              "No entities or tables were extracted for this project — no ORM models, no DDL, and no query " +
              "named a table.",
            holds: `The analysis holds ${plural((summary.dataFlows ?? []).length, "data flow")}.`,
            next: [
              "clarifydoc_file path=… — the data section shows raw database calls per file",
              (summary.dataFlows ?? []).length > 0 && "clarifydoc_data_flows — what routes and screens reach",
              await stalenessHint(ctx.store),
            ],
          }),
        };
      }

      const entityName = stringArg(args, "entity");
      if (!entityName) {
        const query = stringArg(args, "query");
        const nodes = query ? graph.nodes.filter((n) => contains(n.name, query)) : graph.nodes;
        const relationCount = new Map<string, number>();
        for (const edge of graph.edges) {
          relationCount.set(edge.source, (relationCount.get(edge.source) ?? 0) + 1);
          relationCount.set(edge.target, (relationCount.get(edge.target) ?? 0) + 1);
        }
        return {
          text: joinLines([
            `# Data model — ${nodes.length} entit${nodes.length === 1 ? "y" : "ies"}, ${graph.edges.length} relations`,
            `orms: ${countMap(tally(graph.nodes, (n) => n.orm ?? "unknown")) || "unknown"}`,
            "",
            ...bulletList(
              [...nodes].sort((a, b) => byOrdinal(a.name, b.name)),
              limit,
              (n) =>
                `${n.name} [${n.kind}${n.orm ? `, ${n.orm}` : ""}] — ${plural(n.columns.length, "column")}, ` +
                `${plural(relationCount.get(n.id) ?? 0, "relation")} (${loc(n.filePath, n.line)})`,
            ),
          ]),
        };
      }

      const matches = index.entitiesByName.get(entityName.toLowerCase()) ?? [];
      if (matches.length === 0) {
        const near = graph.nodes.filter((n) => contains(n.name, entityName)).map((n) => n.name);
        return {
          text: noResults({
            headline: `No entity named "${entityName}".`,
            holds:
              `The data model holds ${plural(graph.nodes.length, "entity", "entities")}` +
              (near.length ? `; ${cap(near, 10).shown.join(", ")} contain the name.` : "."),
            next: [
              near.length > 0 && `clarifydoc_data_model entity="${near[0]}"`,
              near.length === 0 && `clarifydoc_search query="${entityName}" kinds=["entity"]`,
              "clarifydoc_data_model with no argument — the full inventory",
            ],
          }),
          // A name that matches nothing at all is a caller error worth flagging;
          // a near miss is an answer with a correction in it.
          isError: near.length === 0,
        };
      }

      const blocks: string[][] = [];
      for (const node of matches) {
        blocks.push(describeEntity(node, graph.edges, loaded, limit));
      }
      return { text: joinLines(blocks) };
    },
  };
}

function describeEntity(
  node: EntityGraphNode,
  edges: EntityGraphEdge[],
  loaded: Awaited<ReturnType<typeof requireAnalysis>>,
  limit: number,
): string[] {
  const nameById = new Map(loaded.summary.entityGraph!.nodes.map((n) => [n.id, n.name]));
  const related = edges.filter((e) => e.source === node.id || e.target === node.id);

  const lines: string[] = [
    `# ${node.name} [${node.kind}${node.orm ? `, ${node.orm}` : ""}]`,
    facts([
      ["declared at", loc(node.filePath, node.line)],
      ["columns", node.columns.length],
      ["relations", related.length],
    ]),
    "",
  ];

  if (node.columns.length) {
    lines.push(
      ...section(
        "Columns",
        bulletList(
          node.columns,
          Math.max(limit, 40),
          (c) =>
            `${c.name}${c.type ? `: ${c.type}` : ""}${c.isPrimaryKey ? " [pk]" : ""}${c.isForeignKey ? " [fk]" : ""}`,
        ),
      ),
    );
  }

  if (related.length) {
    lines.push(
      ...section(
        "Relations",
        bulletList(related, limit, (e) => {
          const otherId = e.source === node.id ? e.target : e.source;
          const thisCard = e.source === node.id ? e.sourceCardinality : e.targetCardinality;
          const otherCard = e.source === node.id ? e.targetCardinality : e.sourceCardinality;
          return (
            `${thisCard} → ${otherCard} ${nameById.get(otherId) ?? otherId}` +
            `${e.fields.length ? ` via ${e.fields.join(", ")}` : ""}` +
            `${e.foreignKey ? ` (fk ${e.foreignKey})` : ""}` +
            `${e.joinTable ? ` (join table ${e.joinTable})` : ""}` +
            `${e.selfRef ? " [self-referential]" : ""}${confidenceNote(e.confidence)}`
          );
        }),
      ),
    );
  }

  if (node.referencingModels?.length) {
    lines.push(
      ...section(
        `Models holding this entity in type position (${node.referencingModels.length})`,
        bulletList(
          node.referencingModels,
          limit,
          (m) => `${m.name}${m.isInterface ? " (interface)" : ""} (${m.filePath}) — ${m.count} refs [${m.kinds.join(", ")}]`,
        ),
      ),
    );
  }

  // Who touches it: the symbol-level data access rows resolved to this entity.
  const accessors = (loaded.summary.symbolDataAccess ?? []).filter(
    (a) => a.entity.toLowerCase() === node.name.toLowerCase(),
  );
  if (accessors.length) {
    lines.push(
      ...section(
        `Accessed by (${accessors.length} functions)`,
        bulletList(
          accessors,
          limit,
          (a) =>
            `${a.symbol}() (${loc(a.file, a.symbolLine)}) ${a.access ?? "database"}${
              a.datastore ? ` via ${a.datastore}` : ""
            } — ${cap(a.sites.map((s) => `${s.name}:${s.line}`), 4).shown.join(", ")}`,
        ),
      ),
    );
  }

  // Entry points that reach it, from the source→sink flow rows.
  const flows = (loaded.summary.dataFlows ?? []).filter(
    (f) => f.resource.toLowerCase() === node.name.toLowerCase(),
  );
  if (flows.length) {
    lines.push(
      ...section(
        `Reached from (${flows.length} entry points)`,
        bulletList(
          flows,
          limit,
          (f) =>
            `${f.entryKind} ${f.entryLabel} → ${f.effect}${f.distance > 0 ? ` (${f.distance} hops)` : ""} (${f.entryFile})${confidenceNote(f.confidence)}`,
        ),
      ),
    );
  }

  return lines;
}

const EFFECTS = ["db", "db-read", "db-write", "queue-publish", "queue-consume", "api-call"] as const;

export function dataFlowsTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_data_flows",
    title: "Route/screen → data effect flows",
    description:
      "Source→sink rows: UI screens and API routes that transitively reach a data effect — a table read or " +
      "written, a queue published or consumed, an outbound API call — with the number of call-graph hops and the " +
      "confidence of the path. Filter by effect (e.g. db-write) to answer 'which endpoints can modify this data'.",
    inputSchema: {
      type: "object",
      properties: {
        effect: {
          type: "string",
          enum: [...EFFECTS],
          description: "Only flows with this effect kind.",
        },
        resource: { type: "string", description: "Only flows touching this table/queue/endpoint (substring)." },
        entry: { type: "string", description: "Only flows from this entry point (route path, screen name or file)." },
        entryKind: { type: "string", enum: ["route", "screen"], description: "Only route or only screen entries." },
        limit: { type: "number", description: "Max entry points (default 25)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const flows = loaded.summary.dataFlows ?? [];
      if (flows.length === 0) {
        const entities = loaded.summary.entityGraph?.nodes ?? [];
        return {
          text: noResults({
            headline:
              "No data flows were computed — this project has no resolved data access reachable from a route " +
              "or screen.",
            holds: `The analysis holds ${plural(entities.length, "entity", "entities")}.`,
            next: [
              entities.length > 0 && "clarifydoc_data_model — the entities and who reads or writes them",
              "clarifydoc_file path=… — the data section, for the raw access that exists",
            ],
          }),
        };
      }
      const effect = enumArg(args, "effect", EFFECTS);
      const resource = stringArg(args, "resource");
      const entry = stringArg(args, "entry");
      const entryKind = enumArg(args, "entryKind", ["route", "screen"] as const);
      const limit = numberArg(args, "limit", 25, { max: 200 });

      let rows = flows;
      if (effect) rows = rows.filter((f) => f.effect === effect);
      if (entryKind) rows = rows.filter((f) => f.entryKind === entryKind);
      if (resource) rows = rows.filter((f) => contains(f.resource, resource));
      if (entry) {
        rows = rows.filter((f) => contains(f.entryLabel, entry) || contains(f.entryFile, entry));
      }
      if (rows.length === 0) {
        const drop = filterToDrop(flows, [
          effect ? { label: "effect", keep: (f: DataFlowPath) => f.effect === effect } : undefined,
          entryKind ? { label: "entryKind", keep: (f: DataFlowPath) => f.entryKind === entryKind } : undefined,
          resource ? { label: "resource", keep: (f: DataFlowPath) => contains(f.resource, resource) } : undefined,
          entry
            ? {
                label: "entry",
                keep: (f: DataFlowPath) => contains(f.entryLabel, entry) || contains(f.entryFile, entry),
              }
            : undefined,
        ].filter((f): f is DroppableFilter<DataFlowPath> => f !== undefined));
        return {
          text: noResults({
            headline: missHeadline("data flows", [
              ["effect", effect],
              ["resource", resource],
              ["entry", entry],
              ["entryKind", entryKind],
            ]),
            holds:
              `The analysis holds ${plural(flows.length, "flow")}; effects present: ` +
              `${countMap(tally(flows, (f) => f.effect))}.`,
            next: [
              drop && `clarifydoc_data_flows without \`${drop.label}\` (${plural(drop.count, "match", "matches")})`,
              resource && `clarifydoc_data_model query="${resource}" — is the table in the model at all`,
            ],
          }),
        };
      }

      // Group by entry point so an endpoint's whole data footprint reads as one
      // row. The group carries its own fields — entry labels contain spaces
      // ("POST /api/orders"), so nothing is parsed back out of the key.
      const grouped = new Map<string, { kind: string; label: string; file: string; rows: typeof rows }>();
      for (const row of rows) {
        const key = [row.entryKind, row.entryLabel, row.entryFile].join("|");
        const group = grouped.get(key);
        if (group) group.rows.push(row);
        else grouped.set(key, { kind: row.entryKind, label: row.entryLabel, file: row.entryFile, rows: [row] });
      }
      const entries = [...grouped.values()].sort((a, b) => b.rows.length - a.rows.length);
      const { shown, hidden } = cap(entries, limit);

      const body = shown.map(({ kind, label, file, rows: group }) => {
        const head = `- ${kind} ${label} (${file})`;
        const effects = bulletList(
          [...group].sort((a, b) => a.distance - b.distance),
          10,
          (f) =>
            `${f.effect} ${f.resource}${f.distance > 0 ? ` — ${f.distance} hops` : " — direct"}${confidenceNote(f.confidence)}`,
          { indent: "  " },
        );
        return [head, ...effects].join("\n");
      });

      return {
        text: joinLines([
          `# Data flows — ${rows.length} row${rows.length === 1 ? "" : "s"} across ${entries.length} entry points`,
          `effects: ${countMap(tally(rows, (f) => f.effect))}`,
          "",
          ...body,
          hidden ? `  … ${hidden} more entry points (raise \`limit\` or filter)` : "",
        ]),
      };
    },
  };
}
