import { buildGraph, GRAPH_KINDS, type GraphKind } from "./graph-model.js";
import { toGraphml } from "./graphml.js";
import { toCypher } from "./cypher.js";
import { buildDiagram, toMermaidFile, DIAGRAM_KINDS, type DiagramKind } from "./mermaid.js";
import { architectureDoc, dataModelDoc, flowsDoc, projectName } from "./markdown.js";
import type { Summary } from "./types.js";
import { buildOpenApi } from "../core/openapi-export.js";
import { toCycloneDx } from "./sbom.js";
import { entitiesCsv, graphEdgesCsv, graphNodesCsv, routesCsv } from "./csv.js";
import { obsidianVault, type BundleFile } from "./obsidian.js";

/**
 * The export catalogue: every artifact an analysis's graph can leave the tool
 * as — committed Markdown for a PR or an ADR, Mermaid for a slide or a README,
 * GraphML for Gephi/yEd/Cytoscape, Cypher for Neo4j. Each is rendered from a
 * denormalized `project-summary.json` (`loadReportSummary`), which carries the
 * cross-tier facts — `apiRouteLinks`, `symbolDataAccess` — the viewer payload
 * folds away. Adding a format means adding one entry here.
 */
export interface ExportFormat {
  /** File name the artifact is written under (and its identifier). */
  name: string;
  contentType: string;
  /** One line describing it. */
  description: string;
  render: (summary: Summary) => string;
}

const MARKDOWN = "text/markdown; charset=utf-8";
const MERMAID = "text/vnd.mermaid; charset=utf-8";
const GRAPHML = "application/graphml+xml; charset=utf-8";
const CYPHER = "text/x-cypher; charset=utf-8";
const CSV = "text/csv; charset=utf-8; header=present";

const DIAGRAM_TITLES: Record<DiagramKind, string> = {
  context: "Sub-project container overview, edges weighted by cross-project link count",
  er: "Entity-relationship diagram with crow's-foot multiplicity",
  flows: "Caller to API route to table or queue",
  deployment: "Deployed services and the edges their environment evidences",
};

const GRAPH_TITLES: Record<GraphKind, string> = {
  files: "File dependency graph, with proximity, confidence, layer, sub-project and community",
  classes: "Class and interface reference graph",
  entities: "Entity-relationship graph",
  "data-access": "Files to the datastores, tables and queues they reach",
};

function catalogue(): ExportFormat[] {
  const formats: ExportFormat[] = [
    {
      name: "ARCHITECTURE.md",
      contentType: MARKDOWN,
      description: "Sub-projects, frameworks, layers, deployment topology, dependencies and the health grade with its drivers.",
      render: architectureDoc,
    },
    {
      name: "DATA-MODEL.md",
      contentType: MARKDOWN,
      description: "Entities with their columns and relationships, and the functions that read or write each one.",
      render: dataModelDoc,
    },
    {
      name: "openapi.json",
      contentType: "application/json; charset=utf-8",
      description: "OpenAPI 3.1 — every API route the code declares, with its parameters, request body schema and security.",
      render: (summary) => JSON.stringify(buildOpenApi(summary as never, { title: projectName(summary) }), null, 2) + "\n",
    },
    {
      name: "sbom.cdx.json",
      contentType: "application/vnd.cyclonedx+json; charset=utf-8",
      description: "CycloneDX 1.5 SBOM — the declared dependencies with purls, installed versions, licences and scope.",
      render: (summary) => JSON.stringify(toCycloneDx(summary, projectName(summary)), null, 2) + "\n",
    },
    {
      name: "FLOWS.md",
      contentType: MARKDOWN,
      description: "Every endpoint with a resolved caller or data effect: the cross-tier screen-to-table chain as text.",
      render: flowsDoc,
    },
    {
      name: "routes.csv",
      contentType: CSV,
      description: "CSV — every route with its handler, file, guards, callers and the data it reaches.",
      render: routesCsv,
    },
    {
      name: "entities.csv",
      contentType: CSV,
      description: "CSV — every entity with its columns, relations, the functions that reach it and the routes that do.",
      render: entitiesCsv,
    },
  ];
  for (const kind of DIAGRAM_KINDS) {
    formats.push({
      name: `${kind}.mmd`,
      contentType: MERMAID,
      description: `Mermaid — ${DIAGRAM_TITLES[kind]}.`,
      render: (summary) => toMermaidFile(buildDiagram(summary, kind), projectName(summary), summary.analyzedAt ?? "unknown"),
    });
  }
  for (const kind of GRAPH_KINDS) {
    formats.push({
      name: `${kind}.graphml`,
      contentType: GRAPHML,
      description: `GraphML for Gephi / yEd / Cytoscape — ${GRAPH_TITLES[kind]}.`,
      render: (summary) => toGraphml(buildGraph(summary, kind), projectName(summary), summary.analyzedAt ?? "unknown"),
    });
    formats.push({
      name: `${kind}.cypher`,
      contentType: CYPHER,
      description: `Neo4j Cypher — ${GRAPH_TITLES[kind]}.`,
      render: (summary) => toCypher(buildGraph(summary, kind), projectName(summary), summary.analyzedAt ?? "unknown"),
    });
    formats.push({
      name: `${kind}.nodes.csv`,
      contentType: CSV,
      description: `CSV node table (with ${kind}.edges.csv, for Gephi's spreadsheet import) — ${GRAPH_TITLES[kind]}.`,
      render: (summary) => graphNodesCsv(buildGraph(summary, kind)),
    });
    formats.push({
      name: `${kind}.edges.csv`,
      contentType: CSV,
      description: `CSV edge table — ${GRAPH_TITLES[kind]}.`,
      render: (summary) => graphEdgesCsv(buildGraph(summary, kind)),
    });
  }
  return formats;
}

/** Every export format, in catalogue order. */
export const EXPORT_FORMATS: readonly ExportFormat[] = catalogue();

const BY_NAME = new Map(EXPORT_FORMATS.map((f) => [f.name.toLowerCase(), f]));

/** Look a format up by its file name, case-insensitively (`flows.md` is fine). */
export function findExportFormat(name: string): ExportFormat | undefined {
  return BY_NAME.get(name.toLowerCase());
}

/**
 * Render one format from a loaded summary (`loadReportSummary`). Throws for an
 * unknown name; the summary is read as JSON, so any engine version's works.
 */
export function renderExport(name: string, summary: unknown): string {
  const format = findExportFormat(name);
  if (!format) throw new Error(`Unknown export "${name}". Known: ${EXPORT_FORMATS.map((f) => f.name).join(", ")}`);
  return format.render(summary as Summary);
}

/**
 * Exports that are a directory of files rather than one: written by
 * `clarifydoc export --format <name>` into `<out-dir>/<name>/`.
 */
export interface ExportBundle {
  name: string;
  description: string;
  render: (summary: Summary) => BundleFile[];
}

export const EXPORT_BUNDLES: readonly ExportBundle[] = [
  {
    name: "obsidian",
    description: "Obsidian vault — a note per route, screen, entity and sub-project, wikilinked screen → route → entity.",
    render: obsidianVault,
  },
];

/** Look a bundle up by name, case-insensitively. */
export function findExportBundle(name: string): ExportBundle | undefined {
  return EXPORT_BUNDLES.find((b) => b.name.toLowerCase() === name.toLowerCase());
}

export type { BundleFile } from "./obsidian.js";
