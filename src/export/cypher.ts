import type { AttrValue, Attrs, ExportGraph } from "./graph-model.js";
import { commentLine, cypherStr } from "./text.js";

/**
 * Cypher writer — the same graph as a script you can pipe into `cypher-shell`
 * or paste into Neo4j Browser.
 *
 * Every node carries the shared `:ClarifyDoc` label in addition to its own, so
 * the script can open with one index that makes all the edge `MATCH`es cheap;
 * without it, loading a 20k-edge graph degrades into 20k full scans. Statements
 * are `MERGE`, not `CREATE`, so re-running the script against a database that
 * already holds the graph updates it instead of duplicating it. A node merges on
 * the shared label and its id ONLY, its own label set afterwards: a pattern
 * naming the type would make a second node when another graph kind, or a later
 * run, gives the same id another type. A relationship merges on its endpoints
 * and type; when one graph holds several of one type between the same pair,
 * each carries its ordinal `key`, so a reload neither duplicates nor collapses
 * them.
 */

const SHARED_LABEL = "ClarifyDoc";

function literal(value: AttrValue): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : cypherStr(String(value));
  if (typeof value === "boolean") return value ? "true" : "false";
  return cypherStr(value);
}

/** Property map body. Keys are writer-controlled identifiers, so they are safe bare. */
function props(attrs: Attrs): string {
  const parts: string[] = [];
  for (const name of Object.keys(attrs)) {
    const value = attrs[name];
    if (value === null || value === undefined || value === "") continue;
    parts.push(`${name}: ${literal(value)}`);
  }
  return parts.join(", ");
}

/** Node labels and relationship types come from a closed set, but backtick anyway. */
function token(value: string): string {
  return `\`${value.replace(/`/g, "")}\``;
}

export function toCypher(graph: ExportGraph, projectName: string, analyzedAt: string): string {
  const out: string[] = [];
  const comment = (text: string): string => `// ${commentLine(text)}\n`;
  out.push(comment(`ClarifyDoc ${graph.kind} graph of ${projectName}, analyzed ${analyzedAt}.`));
  out.push(comment(graph.description));
  if (graph.truncated) {
    const { nodes, edges } = graph.truncated;
    if (nodes) out.push(comment(`TRUNCATED: ${nodes.kept} of ${nodes.total} nodes, by ${nodes.by}.`));
    if (edges) out.push(comment(`TRUNCATED: ${edges.kept} of ${edges.total} edges, by ${edges.by}.`));
  }
  out.push(`// ${graph.nodes.length} nodes, ${graph.edges.length} edges. Re-runnable: every statement MERGEs.\n`);
  if (!graph.directed) {
    // Cypher has no undirected relationship. The orientation below is the
    // canonical one the analyzer stored, not a claim about which side owns
    // the relationship — read the cardinality properties for that, and match
    // with `-[r]-` rather than `-[r]->`.
    out.push("// Undirected graph: edge orientation is canonical only. Match with -[r]- and read the cardinality properties.\n");
  }
  out.push("\n");
  out.push(
    `CREATE INDEX clarifydoc_id IF NOT EXISTS FOR (n:${token(SHARED_LABEL)}) ON (n.id);\n\n`,
  );

  const known = new Set<string>();
  for (const node of graph.nodes) {
    known.add(node.id);
    const body = props({ label: node.label, ...node.attrs });
    const set = body ? `, n += {${body}}` : "";
    out.push(`MERGE (n:${token(SHARED_LABEL)} {id: ${cypherStr(node.id)}}) SET n:${token(node.type)}${set};\n`);
  }

  const tripleOf = (edge: { source: string; target: string; relation: string }): string =>
    `${edge.source}\u0000${edge.relation}\u0000${edge.target}`;
  const parallel = new Map<string, number>();
  for (const edge of graph.edges) parallel.set(tripleOf(edge), (parallel.get(tripleOf(edge)) ?? 0) + 1);
  const ordinal = new Map<string, number>();

  if (graph.edges.length > 0) out.push("\n");
  for (const edge of graph.edges) {
    // An edge whose endpoint was cut by the node cap would MATCH nothing and
    // silently no-op; drop it rather than ship a statement that does nothing.
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    const body = props(edge.attrs);
    const set = body ? `\nSET r += {${body}}` : "";
    const triple = tripleOf(edge);
    let key = "";
    if ((parallel.get(triple) ?? 0) > 1) {
      const index = ordinal.get(triple) ?? 0;
      ordinal.set(triple, index + 1);
      key = ` {key: ${index}}`;
    }
    out.push(
      `MATCH (a:${token(SHARED_LABEL)} {id: ${cypherStr(edge.source)}}), ` +
        `(b:${token(SHARED_LABEL)} {id: ${cypherStr(edge.target)}})\n` +
        `MERGE (a)-[r:${token(edge.relation)}${key}]->(b)${set};\n`,
    );
  }
  return out.join("");
}
