import type { Summary } from "./types.js";
import { byDesc, commentLine, idFactory, mermaidLabel, plural } from "./text.js";

/**
 * Mermaid diagram writers.
 *
 * These exist because the D3 graphs in `report.html` are better interactively
 * and unavailable everywhere else, while Mermaid renders natively in GitHub,
 * GitLab, Obsidian and most markdown viewers — which is exactly where the
 * markdown exports land. So the subset here is deliberately the *linear,
 * small* shapes Mermaid renders well (a container overview, an ER diagram, a
 * screen→endpoint→table chain), not a re-implementation of the force graph.
 *
 * Every diagram is hard-capped. Mermaid degrades badly past roughly fifty
 * nodes, and a diagram that silently drops two thirds of a graph is worse than
 * no diagram: each writer returns the cap it applied in `note`, and every
 * caller renders it next to the picture.
 */

const NODE_CAP = 50;
/**
 * Edges need their own ceiling. Fifty nodes can carry two thousand edges, and
 * a hairball at that density is unreadable long before Mermaid gives up on it.
 */
const EDGE_CAP = 80;

/** Short readable stem for a node id — the basename, without its extension. */
function stem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export type DiagramKind = "context" | "er" | "flows" | "deployment";

export const DIAGRAM_KINDS: DiagramKind[] = ["context", "er", "flows", "deployment"];

export interface Diagram {
  kind: DiagramKind;
  title: string;
  /** Bare Mermaid source — no fences. Empty when there was nothing to draw. */
  text: string;
  /** Cap applied, or why the diagram is empty. Always rendered beside the diagram. */
  note?: string;
}

/**
 * Mermaid ER identifiers cannot be quoted, so they are derived, not escaped.
 * Keyed on the node id rather than the name: two files can declare an entity
 * of the same name, and keying on the name would emit one Mermaid entity with
 * two attribute blocks — silently claiming they are the same table.
 */
function erName(nodeId: string, name: string, id: (key: string, hint?: string) => string): string {
  return id(nodeId, name);
}

function word(raw: string | null | undefined, fallback: string): string {
  const cleaned = String(raw ?? "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

// ─── Context: one node per sub-project, edges weighted by cross-project links ──

function context(summary: Summary): Diagram {
  const subProjects = summary.subProjects ?? [];
  const fileProjects = summary.fileProjects ?? {};
  const links = summary.linkGraph ?? [];

  const fileCount = new Map<string, number>();
  for (const file of Object.keys(fileProjects)) {
    const project = fileProjects[file];
    fileCount.set(project, (fileCount.get(project) ?? 0) + 1);
  }

  // Two kinds of cross-project edge, counted separately because they mean
  // different things. A file link is one project importing or calling into
  // another's source; an apiRouteLink is one project calling another over
  // HTTP, which is the edge that matters most in a frontend/backend split and
  // the one the link graph cannot see at all — without it the container
  // overview of a React-plus-Express repo comes out with no edges whatsoever.
  interface Weight {
    links: number;
    api: number;
  }
  const weights = new Map<string, Weight>();
  const bump = (from: string | undefined, to: string | undefined, field: keyof Weight): void => {
    if (!from || !to || from === to) return;
    const key = `${from}>${to}`;
    const weight = weights.get(key) ?? { links: 0, api: 0 };
    weight[field]++;
    weights.set(key, weight);
  };
  for (const link of links) bump(fileProjects[link.source], fileProjects[link.target], "links");
  for (const link of summary.apiRouteLinks ?? []) {
    // A test calling its own service is not a dependency between projects.
    if (link.sourceRole) continue;
    bump(fileProjects[link.source], fileProjects[link.target], "api");
  }

  // A sub-project with no files and no edges is a marker the detector found
  // and nothing else; drawing it adds a node that explains nothing.
  const shown = subProjects
    .filter((project) => (fileCount.get(project.id) ?? 0) > 0)
    .sort(byDesc((project) => fileCount.get(project.id) ?? 0, (project) => project.name))
    .slice(0, NODE_CAP);

  if (shown.length === 0) {
    return { kind: "context", title: "Sub-projects", text: "", note: "No sub-projects were detected." };
  }

  const id = idFactory("p");
  const lines = ["flowchart LR"];
  for (const project of shown) {
    const frameworks = (project.frameworks ?? [])
      .filter((framework) => framework.confidence === "high")
      .slice(0, 2)
      .map((framework) => framework.name)
      .join(", ");
    const parts = [project.kind, frameworks, `${fileCount.get(project.id) ?? 0} files`].filter(Boolean);
    lines.push(
      `  ${id(project.id, project.name)}["${mermaidLabel(project.name)}<br/>${mermaidLabel(parts.join(" · "))}"]`,
    );
  }
  const visible = new Set(shown.map((project) => project.id));
  const candidates = Array.from(weights.keys())
    .map((key) => {
      const cut = key.lastIndexOf(">");
      const weight = weights.get(key)!;
      return { from: key.slice(0, cut), to: key.slice(cut + 1), ...weight };
    })
    .filter((edge) => visible.has(edge.from) && visible.has(edge.to))
    .sort(byDesc((edge) => edge.links + edge.api, (edge) => `${edge.from}>${edge.to}`));
  const edges = candidates.slice(0, EDGE_CAP);
  for (const edge of edges) {
    const label = [
      edge.links > 0 ? plural(edge.links, "link") : "",
      edge.api > 0 ? plural(edge.api, "API call") : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`  ${id(edge.from)} -->|"${mermaidLabel(label)}"| ${id(edge.to)}`);
  }

  const hidden = subProjects.filter((project) => (fileCount.get(project.id) ?? 0) > 0).length - shown.length;
  const noteParts: string[] = [];
  if (hidden > 0) noteParts.push(`${hidden} further sub-project(s) omitted at the ${NODE_CAP}-node cap`);
  if (candidates.length > edges.length) {
    noteParts.push(`${edges.length} of ${candidates.length} cross-project edges drawn, heaviest first`);
  }
  noteParts.push("edge labels count cross-project file links and HTTP calls");
  return { kind: "context", title: "Sub-projects", text: lines.join("\n"), note: `${noteParts.join("; ")}.` };
}

// ─── ER: entityGraph as a Mermaid erDiagram ───────────────────────────────────

const COLUMN_CAP = 25;

function erDiagram(summary: Summary): Diagram {
  const graph = summary.entityGraph ?? null;
  const nodes = (graph?.nodes ?? []).filter((node) => node.kind !== "enum");
  const edges = graph?.edges ?? [];
  if (nodes.length === 0) {
    return { kind: "er", title: "Entity relationships", text: "", note: "No ORM entities or SQL tables were found." };
  }

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const shown = nodes
    .slice()
    .sort(byDesc((node) => degree.get(node.id) ?? 0, (node) => node.name))
    .slice(0, NODE_CAP);
  const visible = new Map(shown.map((node) => [node.id, node]));

  const id = idFactory("e");
  const lines = ["erDiagram"];
  let trimmedColumns = 0;
  for (const node of shown) {
    const name = erName(node.id, node.name, id);
    const all = node.columns ?? [];
    const columns = all.slice(0, COLUMN_CAP);
    if (all.length > columns.length) trimmedColumns++;
    lines.push(`  ${name} {`);
    for (const column of columns) {
      const key = column.isPrimaryKey ? " PK" : column.isForeignKey ? " FK" : "";
      lines.push(`    ${word(column.type, "unknown")} ${word(column.name, "column")}${key}`);
    }
    lines.push("  }");
  }
  let drawn = 0;
  for (const edge of edges) {
    if (drawn >= EDGE_CAP) break;
    const source = visible.get(edge.source);
    const target = visible.get(edge.target);
    if (!source || !target) continue;
    const left = edge.sourceCardinality === "many" ? "}o" : "||";
    const right = edge.targetCardinality === "many" ? "o{" : "||";
    // Solid is Mermaid's "identifying" relationship; reserve it for edges the
    // extractor actually saw, so an inferred relation is visibly weaker.
    const line = edge.confidence === "EXTRACTED" ? "--" : "..";
    const label = (edge.fields ?? []).join(", ") || edge.foreignKey || "relates";
    lines.push(`  ${erName(source.id, source.name, id)} ${left}${line}${right} ${erName(target.id, target.name, id)} : "${mermaidLabel(label)}"`);
    drawn++;
  }

  const hiddenNodes = nodes.length - shown.length;
  const noteParts: string[] = [];
  if (hiddenNodes > 0) {
    noteParts.push(`${shown.length} of ${nodes.length} entities shown (highest-degree first, ${NODE_CAP}-node cap)`);
  }
  if (drawn < edges.length) noteParts.push(`${drawn} of ${edges.length} relationships drawn`);
  if (trimmedColumns > 0) {
    noteParts.push(`${trimmedColumns} entity/entities show only their first ${COLUMN_CAP} columns — DATA-MODEL.md has them all`);
  }
  noteParts.push("dotted relationships are inferred rather than extracted");
  return { kind: "er", title: "Entity relationships", text: lines.join("\n"), note: `${noteParts.join("; ")}.` };
}

// ─── Flows: screen/caller → API route → table ─────────────────────────────────

export interface RouteChain {
  key: string;
  label: string;
  file: string;
  handler: string | null;
  callers: Array<{ file: string; line: number; method: string | null; confidence?: string }>;
  effects: Array<{ effect: string; resource: string; confidence?: string; distance?: number }>;
}

/**
 * The cross-tier chain, assembled once and reused by the diagram and by
 * FLOWS.md.
 *
 * Both halves join on facts the analyzer already keyed the same way:
 * `apiRouteLinks` names the backend file and line of the route it matched, and
 * `computeDataFlows` labels each flow `"<METHOD> <path>"` against the route's
 * own file. Neither join guesses.
 */
export function routeChains(summary: Summary): RouteChain[] {
  const routes = (summary.routeMap ?? []).filter((route) => route.kind === "api");
  const chains = new Map<string, RouteChain>();
  const keyOf = (file: string, method: string | null, path: string): string =>
    `${file}|${`${method ?? ""} ${path}`.trim()}`;

  for (const route of routes) {
    const file = route.filePath ?? "";
    const key = keyOf(file, route.httpMethod, route.path);
    if (chains.has(key)) continue;
    chains.set(key, {
      key,
      label: `${route.httpMethod ?? ""} ${route.path}`.trim(),
      file,
      handler: route.handler,
      callers: [],
      effects: [],
    });
  }

  // Index the routes by the pair `apiRouteLinks` records — declaring file and
  // matched path — so attaching callers stays linear instead of scanning every
  // route per link (both sides run to thousands on a real monorepo).
  const byTarget = new Map<string, typeof routes>();
  for (const route of routes) {
    const key = `${route.filePath ?? ""}|${route.path}`;
    const bucket = byTarget.get(key);
    if (bucket) bucket.push(route);
    else byTarget.set(key, [route]);
  }

  for (const link of summary.apiRouteLinks ?? []) {
    const candidates = byTarget.get(`${link.target}|${link.routePath}`) ?? [];
    // Same file and path can declare several methods. The link carries the
    // matched route's line, so prefer that; fall back to the method, and only
    // then to every candidate — which is what an AMBIGUOUS match means anyway.
    let matches = candidates.filter((route) => route.line === link.targetLine);
    if (matches.length === 0 && link.method) {
      matches = candidates.filter((route) => route.httpMethod === link.method);
    }
    if (matches.length === 0) matches = candidates;
    for (const route of matches) {
      const chain = chains.get(keyOf(route.filePath ?? "", route.httpMethod, route.path));
      if (!chain) continue;
      if (chain.callers.some((caller) => caller.file === link.source && caller.line === link.sourceLine)) continue;
      chain.callers.push({
        file: link.source,
        line: link.sourceLine,
        method: link.method,
        confidence: link.confidence,
      });
    }
  }

  for (const flow of summary.dataFlows ?? []) {
    if (flow.entryKind !== "route") continue;
    const chain = chains.get(`${flow.entryFile}|${flow.entryLabel}`);
    if (!chain) continue;
    chain.effects.push({
      effect: flow.effect,
      resource: flow.resource,
      confidence: flow.confidence,
      distance: flow.distance,
    });
  }

  return Array.from(chains.values())
    .filter((chain) => chain.callers.length > 0 || chain.effects.length > 0)
    .sort(byDesc((chain) => chain.callers.length + chain.effects.length, (chain) => chain.label));
}

function flows(summary: Summary): Diagram {
  const chains = routeChains(summary);
  const withBoth = chains.filter((chain) => chain.callers.length > 0 && chain.effects.length > 0);
  // A chain that only has one half is a fine table row and a poor diagram:
  // drawing it produces a dangling stub. Prefer complete chains, and only fall
  // back to partial ones when there are no complete ones at all.
  const source = withBoth.length > 0 ? withBoth : chains;
  if (source.length === 0) {
    return {
      kind: "flows",
      title: "Screen to endpoint to table",
      text: "",
      note: "No API route had a resolved caller or a reachable data effect.",
    };
  }

  const id = idFactory("f");
  const nodeLines: string[] = [];
  const edgeLines: string[] = [];
  // Keyed on the logical node, not on the generated id: the id factory is
  // told the readable hint the FIRST time a key is seen, so asking it for an
  // id merely to test whether the node exists would freeze the wrong hint.
  const declared = new Set<string>();
  const drawnEdges = new Set<string>();
  const declare = (key: string, hint: string, shape: string): string => {
    const node = id(key, hint);
    if (!declared.has(key)) {
      declared.add(key);
      nodeLines.push(`  ${node}${shape}`);
    }
    return node;
  };
  const connect = (from: string, to: string, label?: string): void => {
    // A caller file with four call sites is four rows in FLOWS.md and one
    // arrow here; without this the same arrow was emitted once per call site.
    const key = `${from}>${label ?? ""}>${to}`;
    if (drawnEdges.has(key)) return;
    drawnEdges.add(key);
    edgeLines.push(label ? `  ${from} -->|"${mermaidLabel(label)}"| ${to}` : `  ${from} --> ${to}`);
  };

  const FANOUT = 3;
  let drawn = 0;
  for (const chain of source) {
    const callers = chain.callers.slice(0, FANOUT);
    const effects = chain.effects.slice(0, FANOUT);
    // Budget against the nodes this chain would actually ADD: callers and
    // tables are shared between chains, so charging each chain for its own
    // copy stopped the diagram at a fifth of the cap it claimed to be using.
    const fresh = new Set<string>([`route:${chain.key}`]);
    for (const caller of callers) fresh.add(`caller:${caller.file}`);
    for (const effect of effects) fresh.add(`res:${effect.resource}`);
    let added = 0;
    fresh.forEach((key) => {
      if (!declared.has(key)) added++;
    });
    if (declared.size + added > NODE_CAP) break;
    // Fifty endpoints sharing a handful of tables stays under the node cap and
    // still produces a hairball, so the edge budget has to stop it too.
    if (edgeLines.length + callers.length + effects.length > EDGE_CAP) break;
    drawn++;

    const routeNode = declare(`route:${chain.key}`, chain.label, `["${mermaidLabel(chain.label)}"]`);
    for (const caller of callers) {
      const key = `caller:${caller.file}`;
      const base = caller.file.slice(caller.file.lastIndexOf("/") + 1);
      connect(declare(key, `caller_${stem(caller.file)}`, `(["${mermaidLabel(base)}"])`), routeNode);
    }
    for (const effect of effects) {
      const key = `res:${effect.resource}`;
      const node = declare(key, `res_${effect.resource}`, `[("${mermaidLabel(effect.resource)}")]`);
      connect(routeNode, node, effect.effect);
    }
  }

  const lines = ["flowchart LR", ...nodeLines, ...edgeLines];
  const noteParts = [`${drawn} of ${chains.length} cross-tier chains drawn (${NODE_CAP}-node cap)`];
  if (withBoth.length === 0) noteParts.push("no chain had both a caller and a data effect, so these are partial");
  noteParts.push(`at most ${FANOUT} callers and ${FANOUT} resources per endpoint`);
  noteParts.push("rounded nodes are callers, cylinders are tables or queues");
  return { kind: "flows", title: "Screen to endpoint to table", text: lines.join("\n"), note: `${noteParts.join("; ")}.` };
}

// ─── Deployment: compose services and the edges evidenced by their env ────────

function deployment(summary: Summary): Diagram {
  const model = summary.deployment ?? null;
  const services = model?.services ?? [];
  const externals = model?.externals ?? [];
  const edges = model?.edges ?? [];
  if (services.length === 0 && externals.length === 0) {
    return {
      kind: "deployment",
      title: "Deployment topology",
      text: "",
      note: "No container-orchestration manifests were found.",
    };
  }

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const shownServices = services
    .slice()
    .sort(byDesc((service) => degree.get(service.name) ?? 0, (service) => service.name))
    .slice(0, NODE_CAP);
  const budget = Math.max(0, NODE_CAP - shownServices.length);
  const shownExternals = externals
    .slice()
    .sort(byDesc((external) => degree.get(external.id) ?? 0, (external) => external.name))
    .slice(0, budget);

  const id = idFactory("s");
  const visible = new Set<string>();
  const lines = ["flowchart LR"];
  for (const service of shownServices) {
    visible.add(service.name);
    const tech = [service.tech, service.family].filter(Boolean)[0];
    // `<br/>` is markup Mermaid honours inside a label; it has to be joined in
    // AFTER escaping, or the escaper turns the line break into literal text.
    const label = mermaidLabel(service.name) + (tech ? `<br/>${mermaidLabel(tech)}` : "");
    const shape =
      service.kind === "datastore" || service.kind === "cache"
        ? `[("${label}")]`
        : service.kind === "queue"
          ? `>"${label}"]`
          : `["${label}"]`;
    lines.push(`  ${id(service.name, service.name)}${shape}`);
  }
  for (const external of shownExternals) {
    visible.add(external.id);
    lines.push(`  ${id(external.id, external.name)}{{"${mermaidLabel(external.name)}"}}`);
  }
  let drawn = 0;
  let drawable = 0;
  for (const edge of edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
    drawable++;
    if (drawn >= EDGE_CAP) continue;
    const label = edge.label ? `${edge.kind}: ${edge.label}` : edge.kind;
    lines.push(`  ${id(edge.from)} -->|"${mermaidLabel(label)}"| ${id(edge.to)}`);
    drawn++;
  }

  const hidden = services.length + externals.length - shownServices.length - shownExternals.length;
  const noteParts: string[] = [];
  if (hidden > 0) noteParts.push(`${hidden} further node(s) omitted at the ${NODE_CAP}-node cap`);
  if (drawn < drawable) noteParts.push(`${drawn} of ${drawable} edges drawn`);
  noteParts.push(`from ${plural((model?.composeFiles ?? []).length, "compose file")}`);
  return {
    kind: "deployment",
    title: "Deployment topology",
    text: lines.join("\n"),
    note: `${noteParts.join("; ")}.`,
  };
}

export function buildDiagram(summary: Summary, kind: DiagramKind): Diagram {
  switch (kind) {
    case "er":
      return erDiagram(summary);
    case "flows":
      return flows(summary);
    case "deployment":
      return deployment(summary);
    default:
      return context(summary);
  }
}

/** A standalone `.mmd` file: the diagram plus its cap note as comments. */
export function toMermaidFile(diagram: Diagram, projectName: string, analyzedAt: string): string {
  // `%%` comments are line-scoped, so nothing interpolated may carry a newline.
  const header = [
    `%% ${commentLine(`ClarifyDoc — ${diagram.title} — ${projectName}`)}`,
    `%% ${commentLine(`Analyzed ${analyzedAt}. Static analysis only.`)}`,
  ];
  if (diagram.note) header.push(`%% ${commentLine(diagram.note)}`);
  if (!diagram.text) return `${header.join("\n")}\n`;
  return `${header.join("\n")}\n${diagram.text}\n`;
}
