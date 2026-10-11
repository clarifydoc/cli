import type { Cfg, CfgNode } from "../types/control-flow.js";
import { mermaidLabel } from "./mermaid-text.js";

/**
 * Render a control-flow graph as a Mermaid flowchart.
 *
 * Mermaid rather than a graph library for the same reason the repo-level
 * exports use it: it is text, so it can be generated per function on demand
 * with nothing to bundle and nothing to lay out ahead of time, and it is
 * diffable if anyone commits one.
 */

/** Past this many nodes a flowchart stops being readable, so it is truncated. */
const NODE_CAP = 300;

/** Shape per node kind. Mermaid's shapes are the only styling that survives copy-paste. */
function shape(node: CfgNode, label: string): string {
  switch (node.kind) {
    case "ENTRY":
    case "EXIT":
      return `(["${label}"])`;
    case "DECISION":
      return `{"${label}"}`;
    case "LOOP":
      return `{{"${label}"}}`;
    case "MERGE":
      return `(("${label}"))`;
    case "RETURN":
    case "THROW":
      return `>"${label}"]`;
    case "BREAK_CONTINUE":
      return `[/"${label}"/]`;
    case "CATCH":
      return `[["${label}"]]`;
    case "STATEMENT":
      return `["${label}"]`;
  }
}

/** The class each kind is assigned, so a stylesheet can colour the categories. */
const CLASS_OF: Record<CfgNode["kind"], string> = {
  ENTRY: "cfEntry",
  EXIT: "cfExit",
  STATEMENT: "cfStatement",
  DECISION: "cfDecision",
  MERGE: "cfMerge",
  LOOP: "cfLoop",
  BREAK_CONTINUE: "cfJump",
  RETURN: "cfReturn",
  THROW: "cfThrow",
  CATCH: "cfCatch",
};

const CLASS_DEFS: readonly string[] = [
  "classDef cfEntry fill:#1f7a3d,stroke:#0f4a24,color:#fff",
  "classDef cfExit fill:#5a3286,stroke:#361d52,color:#fff",
  "classDef cfStatement fill:#2b4a6f,stroke:#16283d,color:#fff",
  "classDef cfDecision fill:#8a6d1f,stroke:#513f10,color:#fff",
  "classDef cfMerge fill:#3a3a3a,stroke:#1e1e1e,color:#fff",
  "classDef cfLoop fill:#1f6f7a,stroke:#0f4249,color:#fff",
  "classDef cfJump fill:#6f4a1f,stroke:#422c12,color:#fff",
  "classDef cfReturn fill:#1f5a7a,stroke:#0f3549,color:#fff",
  "classDef cfThrow fill:#8a2f2f,stroke:#521c1c,color:#fff",
  "classDef cfCatch fill:#7a3f1f,stroke:#492512,color:#fff",
];

/** A rendered Mermaid flowchart and a note about what the drawing leaves out. */
export interface ControlFlowDiagram {
  /** Mermaid source, ready to render or paste into a Markdown fence. */
  text: string;
  /** One line describing what was drawn and anything left out; may be empty. */
  note: string;
}

/** Rendering switches for `toMermaidFlowchart`. */
export interface MermaidOptions {
  /**
   * Emit the `classDef` colour table (default). A host with a theme of its own
   * — the VS Code webview, which has to follow the editor between light and
   * dark — wants the `class` assignments without the colours, and styles the
   * categories itself.
   */
  classDefs?: boolean;
}

/**
 * A node's Mermaid label: the source text, with the count of branches hidden
 * inside it appended. A statement that looks flat but carries four ternaries
 * is precisely what a reader scanning for "where is the complexity" needs
 * flagged, and it is the only place that information exists.
 */
function labelFor(node: CfgNode): string {
  const base = mermaidLabel(node.label || node.kind.toLowerCase());
  const badge = node.inlineBranches > 0 ? ` (+${node.inlineBranches})` : "";
  return `${base}${badge}`;
}

/**
 * Rejoin points that carry no information of their own.
 *
 * The IR keeps an explicit `MERGE` for every place branches come back
 * together, because an analysis wants to know where that is. A reader does
 * not: the arrows already converge on the next statement, and an extra empty
 * node between them is a box to look at and dismiss. So a merge with a single
 * way out is spliced out of the drawing — its inbound edges are re-pointed at
 * whatever it led to.
 */
function collapsibleMerges(cfg: Cfg): Map<string, string> {
  const outgoing = new Map<string, { to: string; count: number }>();
  for (const edge of cfg.edges) {
    const seen = outgoing.get(edge.from);
    if (seen) seen.count++;
    else outgoing.set(edge.from, { to: edge.to, count: 1 });
  }

  const skip = new Map<string, string>();
  for (const node of cfg.nodes) {
    if (node.kind !== "MERGE" || node.label !== "") continue;
    const out = outgoing.get(node.id);
    if (out && out.count === 1) skip.set(node.id, out.to);
  }

  // Merges can chain (nested `if`s closing together), so follow through to the
  // first node that survives. The guard is for safety, not because the builder
  // can produce a cycle of empty merges.
  const resolve = (id: string): string => {
    const seen = new Set<string>();
    let at = id;
    while (skip.has(at) && !seen.has(at)) {
      seen.add(at);
      at = skip.get(at)!;
    }
    return at;
  };
  for (const id of [...skip.keys()]) skip.set(id, resolve(id));
  return skip;
}

/**
 * Render a control-flow graph as a Mermaid `flowchart TD`.
 *
 * Empty merge nodes are spliced out, nodes beyond the drawing cap are dropped
 * (the `note` says how many), and every node gets a `class` by kind so hosts
 * can colour the categories.
 *
 * @param cfg - The graph from `buildControlFlow` or `buildRegexControlFlow`
 * @param options - Whether to include the colour `classDef` table
 * @returns The Mermaid source and a one-line note, possibly empty
 */
export function toMermaidFlowchart(cfg: Cfg, options: MermaidOptions = {}): ControlFlowDiagram {
  const collapsed = collapsibleMerges(cfg);
  const drawable = cfg.nodes.filter((n) => !collapsed.has(n.id));
  const shown = drawable.slice(0, NODE_CAP);
  const visible = new Set(shown.map((n) => n.id));

  const lines = ["flowchart TD"];
  for (const node of shown) {
    lines.push(`  ${node.id}${shape(node, labelFor(node))}`);
  }
  const drawn = new Set<string>();
  for (const raw of cfg.edges) {
    const edge = { ...raw, to: collapsed.get(raw.to) ?? raw.to };
    if (collapsed.has(edge.from)) continue; // its inbound edges carry it instead
    if (edge.from === edge.to) continue; // a collapsed merge that led back on itself
    // Re-pointing can make two edges identical; Mermaid would draw both.
    const key = `${edge.from}>${edge.label ?? ""}>${edge.to}>${edge.back ? "b" : ""}${edge.unwind ? "u" : ""}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
    // Back edges and `finally` detours are both drawn dotted: neither is part
    // of the straight read down the page.
    const arrow = edge.back || edge.unwind ? "-.->" : "-->";
    lines.push(
      edge.label
        ? `  ${edge.from} ${arrow}|"${mermaidLabel(edge.label)}"| ${edge.to}`
        : `  ${edge.from} ${arrow} ${edge.to}`,
    );
  }
  if (options.classDefs !== false) lines.push(...CLASS_DEFS.map((d) => `  ${d}`));
  for (const node of shown) {
    lines.push(`  class ${node.id} ${CLASS_OF[node.kind]}`);
  }

  const parts: string[] = [];
  if (cfg.approximate) {
    // First, because it qualifies everything else in the diagram.
    parts.push(
      `${cfg.language} has no parser here, so this was read off the source text and may misjudge nesting`,
    );
  }
  const hidden = drawable.length - shown.length;
  if (hidden > 0) parts.push(`${hidden} further node(s) omitted at the ${NODE_CAP}-node cap`);
  if (cfg.hasFinally) {
    parts.push(
      "dotted edges into the `finally` are the detour a `return` or `throw` takes on its way out; control then leaves rather than continuing past the `try`",
    );
  }
  if (cfg.unreachableBranches > 0) {
    parts.push(
      `${cfg.unreachableBranches} branch(es) sit in code nothing reaches and are not drawn`,
    );
  }
  if (cfg.unmodelled.length > 0) {
    parts.push(`drawn as plain statements: ${cfg.unmodelled.join(", ")}`);
  }

  return { text: lines.join("\n"), note: parts.join("; ") };
}

/** The diagram wrapped in a Markdown fence, with its note underneath. */
export function toMarkdown(cfg: Cfg): string {
  const diagram = toMermaidFlowchart(cfg);
  const out = [
    `### ${cfg.functionName}`,
    "",
    `\`${cfg.filePath}\`, lines ${cfg.line}–${cfg.endLine}${cfg.approximate ? " (approximate)" : ""}`,
    "",
    "```mermaid",
    diagram.text,
    "```",
  ];
  if (diagram.note) out.push("", `> ${diagram.note}.`);
  return `${out.join("\n")}\n`;
}
