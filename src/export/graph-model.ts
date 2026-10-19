import type { Summary } from "./types.js";

/**
 * One neutral graph shape that both interchange writers emit.
 *
 * GraphML and Cypher want the same three things — typed nodes, typed edges, and
 * attributes on both — so the per-graph knowledge (which ClarifyDoc field is
 * the node set, what an edge means, which facts ride on it) lives here once and
 * neither writer knows anything about analysis.
 *
 * The attribute lists are the point of the export, not decoration. A bare
 * import graph is something any tool can produce; `proximity`, `confidence`,
 * `layer`, `projectId` and `community` are what ClarifyDoc knows that the
 * importer does not, so every graph carries them onto the wire even though
 * they cost bytes.
 */

export type GraphKind = "files" | "classes" | "entities" | "data-access";

export const GRAPH_KINDS: GraphKind[] = ["files", "classes", "entities", "data-access"];

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue | null | undefined>;

export interface ExportNode {
  id: string;
  label: string;
  /** Node class: a GraphML attribute, and the label of the Cypher node. */
  type: string;
  attrs: Attrs;
}

export interface ExportEdge {
  source: string;
  target: string;
  /** Edge class: a GraphML attribute, and the Cypher relationship type. */
  relation: string;
  attrs: Attrs;
}

export interface Cap {
  kept: number;
  total: number;
  by: string;
}

export interface ExportGraph {
  kind: GraphKind;
  /** One line naming what the nodes and edges are — written into every artifact. */
  description: string;
  directed: boolean;
  nodes: ExportNode[];
  edges: ExportEdge[];
  /** Present only when something did not fit. Absent means the graph is whole. */
  truncated?: { nodes?: Cap; edges?: Cap };
}

/**
 * Ceilings, not budgets: they exist so one pathological repo cannot make an
 * export a gigabyte of XML, and they sit far above any graph we have
 * measured (the largest corpus repo is ~5k file nodes / ~20k edges). A graph
 * that hits one says so in the artifact rather than being quietly shortened.
 */
const NODE_CAP = 25_000;
const EDGE_CAP = 100_000;

const PROXIMITY_LABEL: Record<number, string> = { 1: "tight", 2: "medium", 3: "loose" };

/** Drop empty/absent attributes so the writers never emit `foo=""` noise. */
function clean(attrs: Attrs): Attrs {
  const out: Attrs = {};
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === null || value === undefined || value === "") continue;
    out[key] = value;
  }
  return out;
}

function capped<T>(items: T[], cap: number, by: string): { items: T[]; cap?: Cap } {
  if (items.length <= cap) return { items };
  return { items: items.slice(0, cap), cap: { kept: cap, total: items.length, by } };
}

/** file path → community id, inverted from the `communityId → files[]` map. */
function communityOf(summary: Summary): Map<string, string> {
  const out = new Map<string, string>();
  const communities = summary.communities ?? {};
  for (const id of Object.keys(communities)) {
    for (const file of communities[id] ?? []) out.set(file, id);
  }
  return out;
}

function fileGraph(summary: Summary): ExportGraph {
  const community = communityOf(summary);
  const projects = summary.fileProjects ?? {};
  const layers = summary.fileLayerMap ?? {};
  const unused = new Set(summary.unusedFiles ?? []);
  const componentGraph = summary.componentGraph ?? {};
  const links = summary.linkGraph ?? [];

  // Node set: the analyzed files, plus any path an edge names that the file
  // list does not (a dependency on a file outside the scan still deserves a
  // node, or the importer silently drops the edge).
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (path: string | undefined): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    ids.push(path);
  };
  for (const file of summary.files ?? []) add(file);
  for (const link of links) {
    add(link.source);
    add(link.target);
  }
  for (const source of Object.keys(componentGraph)) {
    add(source);
    for (const target of componentGraph[source] ?? []) add(target);
  }

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  const edges: ExportEdge[] = [];
  const pairs = new Set<string>();
  for (const link of links) {
    if (!link.source || !link.target) continue;
    pairs.add(`${link.source}>${link.target}`);
    bump(outDegree, link.source);
    bump(inDegree, link.target);
    const proximity = typeof link.proximity === "number" ? link.proximity : undefined;
    edges.push({
      source: link.source,
      target: link.target,
      relation: "LINKS_TO",
      attrs: clean({
        proximity,
        proximityLabel: proximity !== undefined ? PROXIMITY_LABEL[proximity] : undefined,
        reason: link.reason,
        confidence: link.confidence,
        calls: (link.calls ?? []).join(", "),
      }),
    });
  }
  // Import-graph dependencies the proximity pass did not score. Keeping them
  // separate rather than folding them in preserves the distinction: a
  // LINKS_TO edge is a call that runs at a known time, a DEPENDS_ON edge is a
  // structural dependency and nothing more.
  for (const source of Object.keys(componentGraph)) {
    for (const target of componentGraph[source] ?? []) {
      if (!target || source === target || pairs.has(`${source}>${target}`)) continue;
      pairs.add(`${source}>${target}`);
      bump(outDegree, source);
      bump(inDegree, target);
      edges.push({ source, target, relation: "DEPENDS_ON", attrs: {} });
    }
  }

  const nodes: ExportNode[] = ids.map((path) => ({
    id: path,
    label: path.slice(path.lastIndexOf("/") + 1),
    type: "File",
    attrs: clean({
      path,
      projectId: projects[path],
      layer: layers[path],
      community: community.get(path),
      degreeIn: inDegree.get(path) ?? 0,
      degreeOut: outDegree.get(path) ?? 0,
      unused: unused.has(path) ? true : undefined,
    }),
  }));

  const n = capped(nodes, NODE_CAP, "insertion order");
  const e = capped(edges, EDGE_CAP, "insertion order");
  return {
    kind: "files",
    description:
      "One node per analyzed file. LINKS_TO edges carry proximity (when the call runs) and confidence; DEPENDS_ON edges are import-graph dependencies with no scored call.",
    directed: true,
    nodes: n.items,
    edges: e.items,
    ...truncation(n.cap, e.cap),
  };
}

function classGraph(summary: Summary): ExportGraph {
  const graph = summary.classGraph ?? null;
  const nodes: ExportNode[] = (graph?.nodes ?? []).map((node) => ({
    id: node.id,
    label: node.name,
    type: node.isExternal ? "ExternalType" : node.isFile ? "FileScope" : node.isInterface ? "Interface" : "Class",
    attrs: clean({
      name: node.name,
      path: node.filePath,
      isInterface: node.isInterface,
      isExternal: node.isExternal,
      isEntity: node.isEntity,
      orm: node.orm,
      degreeIn: node.inboundCount,
      degreeOut: node.outboundCount,
    }),
  }));
  const known = new Set(nodes.map((node) => node.id));
  const edges: ExportEdge[] = [];
  for (const edge of graph?.edges ?? []) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    const byKind = edge.byKind ?? {};
    edges.push({
      source: edge.source,
      target: edge.target,
      relation: (edge.category ?? "references").toUpperCase(),
      attrs: clean({
        category: edge.category,
        total: edge.total,
        kinds: Object.keys(byKind)
          .map((kind) => `${kind}:${byKind[kind]}`)
          .join(", "),
      }),
    });
  }
  const n = capped(nodes, NODE_CAP, "source order");
  const e = capped(edges, EDGE_CAP, "source order");
  return {
    kind: "classes",
    description:
      "One node per class, interface or referenced external type. Edges are type references, categorised as inheritance, data composition or signature usage.",
    directed: true,
    nodes: n.items,
    edges: e.items,
    ...truncation(n.cap, e.cap),
  };
}

function entityGraph(summary: Summary): ExportGraph {
  const graph = summary.entityGraph ?? null;
  const nodes: ExportNode[] = (graph?.nodes ?? []).map((node) => {
    const columns = node.columns ?? [];
    const keys = columns.filter((column) => column.isPrimaryKey).map((column) => column.name);
    return {
      id: node.id,
      label: node.name,
      type: node.kind === "enum" ? "Enum" : "Entity",
      attrs: clean({
        name: node.name,
        orm: node.orm,
        kind: node.kind,
        path: node.filePath,
        line: node.line,
        columnCount: columns.length,
        primaryKey: keys.join(", "),
        columns: columns.map((column) => (column.type ? `${column.name}:${column.type}` : column.name)).join(", "),
      }),
    };
  });
  const known = new Set(nodes.map((node) => node.id));
  const edges: ExportEdge[] = [];
  for (const edge of graph?.edges ?? []) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    edges.push({
      source: edge.source,
      target: edge.target,
      relation: "RELATES_TO",
      attrs: clean({
        cardinality: `${edge.sourceCardinality}-to-${edge.targetCardinality}`,
        sourceCardinality: edge.sourceCardinality,
        targetCardinality: edge.targetCardinality,
        fields: (edge.fields ?? []).join(", "),
        foreignKey: edge.foreignKey,
        joinTable: edge.joinTable,
        orm: edge.orm,
        confidence: edge.confidence,
        selfRef: edge.selfRef,
      }),
    });
  }
  const n = capped(nodes, NODE_CAP, "source order");
  const e = capped(edges, EDGE_CAP, "source order");
  return {
    kind: "entities",
    description:
      "One node per ORM entity, SQL table or enum, with its columns. Edges are relationships, with crow's-foot multiplicity at each end and the field that evidences them.",
    // An ER relationship has multiplicity at both ends rather than a direction.
    directed: false,
    nodes: n.items,
    edges: e.items,
    ...truncation(n.cap, e.cap),
  };
}

function dataAccessGraph(summary: Summary): ExportGraph {
  const graph = summary.dataAccessGraph ?? null;
  const typeOf: Record<string, string> = {
    file: "File",
    datastore: "Datastore",
    entity: "Entity",
    queue: "Queue",
  };
  const nodes: ExportNode[] = (graph?.nodes ?? []).map((node) => ({
    id: node.id,
    label: node.name,
    type: typeOf[node.kind] ?? "Node",
    attrs: clean({
      name: node.name,
      kind: node.kind,
      path: node.filePath,
      degreeIn: node.inboundCount,
      degreeOut: node.outboundCount,
    }),
  }));
  const known = new Set(nodes.map((node) => node.id));
  const edges: ExportEdge[] = [];
  for (const edge of graph?.edges ?? []) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    const calls = edge.calls ?? [];
    edges.push({
      source: edge.source,
      target: edge.target,
      relation: "ACCESSES",
      attrs: clean({
        total: edge.total ?? calls.length,
        // The full call list can run to thousands on a hub datastore; the
        // sample is what makes an edge readable in Gephi's inspector.
        callSample: calls
          .slice(0, 10)
          .map((call) => `${call.name}:${call.line}`)
          .join(", "),
      }),
    });
  }
  const n = capped(nodes, NODE_CAP, "source order");
  const e = capped(edges, EDGE_CAP, "source order");
  return {
    kind: "data-access",
    description:
      "Files that perform data access, the datastores, tables and queues they reach, and the call sites that evidence each edge.",
    directed: true,
    nodes: n.items,
    edges: e.items,
    ...truncation(n.cap, e.cap),
  };
}

function truncation(nodes?: Cap, edges?: Cap): { truncated?: { nodes?: Cap; edges?: Cap } } {
  if (!nodes && !edges) return {};
  return { truncated: { ...(nodes ? { nodes } : {}), ...(edges ? { edges } : {}) } };
}

export function buildGraph(summary: Summary, kind: GraphKind): ExportGraph {
  switch (kind) {
    case "classes":
      return classGraph(summary);
    case "entities":
      return entityGraph(summary);
    case "data-access":
      return dataAccessGraph(summary);
    default:
      return fileGraph(summary);
  }
}
