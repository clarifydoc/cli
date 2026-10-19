import type { AttrValue, ExportGraph } from "./graph-model.js";
import { xml } from "./text.js";

/**
 * GraphML writer — the format Gephi, yEd and Cytoscape all import.
 *
 * Two things are worth knowing about the output. Node ids are synthetic
 * (`n0`, `n1`, …) and the real identity travels as an attribute: GraphML types
 * `@id` as an `NMTOKEN`, which excludes `/`, so a file path is not a legal id
 * however many importers tolerate it. And every attribute is declared as a
 * `<key>` up front, because an undeclared `<data>` is what makes a strict
 * reader reject the file outright.
 */

type KeyScope = "node" | "edge";
type KeyType = "string" | "int" | "double" | "boolean";

interface KeyDecl {
  id: string;
  scope: KeyScope;
  name: string;
  type: KeyType;
}

function typeOf(value: AttrValue): KeyType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  return "string";
}

/**
 * Widen rather than conflict: one attribute seen as both `int` and `double`
 * is a double, and anything seen alongside a string is a string. A key
 * declared narrower than its values is the other way this file gets rejected.
 */
function widen(a: KeyType, b: KeyType): KeyType {
  if (a === b) return a;
  if ((a === "int" && b === "double") || (a === "double" && b === "int")) return "double";
  return "string";
}

function collectKeys(graph: ExportGraph): { keys: KeyDecl[]; idFor: Map<string, string> } {
  const byScoped = new Map<string, KeyDecl>();
  const order: string[] = [];
  const note = (scope: KeyScope, name: string, value: AttrValue): void => {
    const scoped = `${scope}:${name}`;
    const existing = byScoped.get(scoped);
    if (existing) {
      existing.type = widen(existing.type, typeOf(value));
      return;
    }
    byScoped.set(scoped, { id: "", scope, name, type: typeOf(value) });
    order.push(scoped);
  };

  for (const node of graph.nodes) {
    note("node", "label", node.label);
    note("node", "type", node.type);
    for (const name of Object.keys(node.attrs)) {
      const value = node.attrs[name];
      if (value !== null && value !== undefined) note("node", name, value);
    }
  }
  for (const edge of graph.edges) {
    note("edge", "relation", edge.relation);
    for (const name of Object.keys(edge.attrs)) {
      const value = edge.attrs[name];
      if (value !== null && value !== undefined) note("edge", name, value);
    }
  }

  const keys: KeyDecl[] = [];
  const idFor = new Map<string, string>();
  order.forEach((scoped, index) => {
    const key = byScoped.get(scoped)!;
    key.id = `d${index}`;
    idFor.set(scoped, key.id);
    keys.push(key);
  });
  return { keys, idFor };
}

function data(keyId: string | undefined, value: AttrValue | null | undefined): string {
  if (!keyId || value === null || value === undefined || value === "") return "";
  return `      <data key="${keyId}">${xml(value)}</data>\n`;
}

export function toGraphml(graph: ExportGraph, projectName: string, analyzedAt: string): string {
  const { keys, idFor } = collectKeys(graph);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  out.push(
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns' +
      ' http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">\n',
  );
  // `<desc>`, not an XML comment: a comment may not contain `--`, and a
  // project name, a route path or a truncation reason can hold anything at
  // all. `<desc>` is ordinary escaped character data and is where the GraphML
  // spec puts exactly this.
  const desc = [
    `ClarifyDoc ${graph.kind} graph of ${projectName}, analyzed ${analyzedAt}.`,
    graph.description,
  ];
  if (graph.truncated) {
    const { nodes, edges } = graph.truncated;
    if (nodes) desc.push(`TRUNCATED: ${nodes.kept} of ${nodes.total} nodes, by ${nodes.by}.`);
    if (edges) desc.push(`TRUNCATED: ${edges.kept} of ${edges.total} edges, by ${edges.by}.`);
  }
  out.push(`  <desc>${xml(desc.join(" "))}</desc>\n`);

  for (const key of keys) {
    out.push(
      `  <key id="${key.id}" for="${key.scope}" attr.name="${xml(key.name)}" attr.type="${key.type}"/>\n`,
    );
  }

  out.push(`  <graph id="${xml(graph.kind)}" edgedefault="${graph.directed ? "directed" : "undirected"}">\n`);

  const nodeId = new Map<string, string>();
  graph.nodes.forEach((node, index) => nodeId.set(node.id, `n${index}`));

  graph.nodes.forEach((node, index) => {
    out.push(`    <node id="n${index}">\n`);
    out.push(data(idFor.get("node:label"), node.label));
    out.push(data(idFor.get("node:type"), node.type));
    for (const name of Object.keys(node.attrs)) {
      out.push(data(idFor.get(`node:${name}`), node.attrs[name]));
    }
    out.push("    </node>\n");
  });

  let index = 0;
  for (const edge of graph.edges) {
    const source = nodeId.get(edge.source);
    const target = nodeId.get(edge.target);
    // An edge whose endpoint was cut by the node cap has nothing to attach to.
    if (!source || !target) continue;
    out.push(`    <edge id="e${index++}" source="${source}" target="${target}">\n`);
    out.push(data(idFor.get("edge:relation"), edge.relation));
    for (const name of Object.keys(edge.attrs)) {
      out.push(data(idFor.get(`edge:${name}`), edge.attrs[name]));
    }
    out.push("    </edge>\n");
  }

  out.push("  </graph>\n");
  out.push("</graphml>\n");
  return out.join("");
}
