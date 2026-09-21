import { describe, it, expect, beforeAll } from "vitest";
import type { Cfg } from "../types/control-flow.js";
import type { Language } from "../types/analysis.js";
import { ensureLanguagesLoaded } from "../extractors/registry.js";
import { extractClasses, extractFunctions } from "../extractors/functions-classes/index.js";
import { parseSource } from "../parsers/parser-manager.js";
import { computeComplexity } from "./complexity-analyzer.js";
import { buildControlFlow } from "./control-flow.js";
import { toMermaidFlowchart, toMarkdown } from "./control-flow-mermaid.js";

/**
 * Every release-blocking defect in the repo-level graph export was an escaping
 * bug that reading the generator could not have caught, so the output is
 * checked by re-reading it rather than by eyeballing a snapshot.
 *
 * This validator is not Mermaid's parser — adding Mermaid (and a DOM for it)
 * as a dependency of the engine to test a few hundred lines of text generation
 * is not a trade worth making. What it does cover is the failure mode that
 * actually bites: a label or an id that carries syntax out into the document,
 * and an edge that names a node the diagram never declared.
 */

const NODE_LINE = /^ {2}([A-Za-z_][A-Za-z0-9_]*)(\(\[|\{\{|\(\(|\[\[|\[\/|\{|>|\[)"(.*)"(\]\)|\}\}|\)\)|\]\]|\/\]|\}|\]|\])$/;
const EDGE_LINE = /^ {2}([A-Za-z_][A-Za-z0-9_]*) (-->|-\.->)(?:\|"(.*)"\|)? ([A-Za-z_][A-Za-z0-9_]*)$/;
const CLASS_LINE = /^ {2}class ([A-Za-z_][A-Za-z0-9_]*) ([A-Za-z][A-Za-z0-9]*)$/;
const CLASSDEF_LINE = /^ {2}classDef [A-Za-z][A-Za-z0-9]* [-a-z0-9:#,]+$/;

interface ParsedDiagram {
  nodes: Map<string, string>;
  edges: { from: string; to: string; label?: string; dotted: boolean }[];
}

/** Re-read generated Mermaid, failing on any line that is not a shape we emit. */
function parseDiagram(text: string): ParsedDiagram {
  const lines = text.split("\n");
  expect(lines[0]).toBe("flowchart TD");

  const nodes = new Map<string, string>();
  const edges: ParsedDiagram["edges"] = [];

  for (const line of lines.slice(1)) {
    const node = NODE_LINE.exec(line);
    if (node) {
      expect(nodes.has(node[1]!)).toBe(false); // a node declared twice is a merge bug
      nodes.set(node[1]!, node[3]!);
      continue;
    }
    const edge = EDGE_LINE.exec(line);
    if (edge) {
      edges.push({
        from: edge[1]!,
        to: edge[4]!,
        label: edge[3],
        dotted: edge[2] === "-.->",
      });
      continue;
    }
    if (CLASS_LINE.test(line) || CLASSDEF_LINE.test(line)) continue;
    throw new Error(`unrecognised Mermaid line: ${JSON.stringify(line)}`);
  }

  for (const edge of edges) {
    expect(nodes.has(edge.from), `edge from undeclared node ${edge.from}`).toBe(true);
    expect(nodes.has(edge.to), `edge to undeclared node ${edge.to}`).toBe(true);
  }
  // No label may carry a character that would end it or open markup.
  for (const label of [...nodes.values(), ...edges.map((e) => e.label ?? "")]) {
    expect(label).not.toMatch(/["<>\n\r]/);
  }
  return { nodes, edges };
}

async function cfgFor(source: string, name?: string): Promise<Cfg> {
  const language = "typescript";
  const tree = await parseSource(source, language, "probe.ts");
  const functions = extractFunctions(tree, source, language as Language);
  const classes = extractClasses(tree, source, language as Language);
  const rows = computeComplexity(tree, language as Language, functions, classes);
  const row = name ? rows.find((r) => r.functionName === name) : rows[0];
  if (!row) throw new Error(`no complexity row for ${name ?? "the first function"}`);
  const cfg = buildControlFlow(
    tree,
    language as Language,
    { name: row.functionName, line: row.line, endLine: row.endLine },
    "probe.ts",
  );
  if (!cfg) throw new Error("no CFG");
  return cfg;
}

beforeAll(async () => {
  await ensureLanguagesLoaded(["typescript"]);
});

describe("toMermaidFlowchart", () => {
  it("emits a diagram whose every edge names a declared node", async () => {
    const cfg = await cfgFor(`
      function f(xs: number[]) {
        for (const x of xs) {
          if (x < 0) continue;
          if (x > 10) break;
          try { use(x); } catch (e) { handle(e); } finally { log(x); }
        }
        switch (xs.length) {
          case 0: return "empty";
          default: return "some";
        }
      }
    `);
    const parsed = parseDiagram(toMermaidFlowchart(cfg).text);
    expect(parsed.nodes.size).toBe(cfg.nodes.length);
    expect(parsed.edges.length).toBe(cfg.edges.length);
    expect(parsed.edges.some((e) => e.dotted)).toBe(true);
  });

  it("carries source text hostile to Mermaid out safely", async () => {
    // Every character here is Mermaid syntax somewhere: quotes end a label,
    // `#` opens its entity escape, `<`/`>` are markup, and the pipe and braces
    // are edge- and shape-delimiters.
    const cfg = await cfgFor(`
      function f(a: string) {
        if (a === '"quoted" #35; <b> | {x} [y] -- end') { return 1; }
        return 2;
      }
    `);
    const diagram = toMermaidFlowchart(cfg);
    const parsed = parseDiagram(diagram.text);
    const decision = [...parsed.nodes.values()].find((l) => l.includes("quoted"))!;
    expect(decision).toContain("#quot;quoted#quot;");
    expect(decision).toContain("#35;35;");
    expect(decision).toContain("#lt;b#gt;");
  });

  it("badges the branches a statement hides", async () => {
    const cfg = await cfgFor(`
      function f(a: number, b: number) {
        const x = a > 0 ? 1 : b > 0 ? 2 : 3;
        return x;
      }
    `);
    const parsed = parseDiagram(toMermaidFlowchart(cfg).text);
    expect([...parsed.nodes.values()].some((l) => /\(\+\d+\)$/.test(l))).toBe(true);
  });

  it("says what it could not draw instead of drawing it wrong", async () => {
    const cfg = await cfgFor(`
      function f() {
        try { return risky(); } finally { cleanup(); }
      }
    `);
    expect(toMermaidFlowchart(cfg).note).toContain("finally");
  });

  it("caps a pathological function and says how much it dropped", async () => {
    const body = Array.from({ length: 400 }, (_, i) => `  step${i}();`).join("\n");
    const cfg = await cfgFor(`function f() {\n${body}\n}`);
    const diagram = toMermaidFlowchart(cfg);
    const parsed = parseDiagram(diagram.text);
    expect(parsed.nodes.size).toBeLessThan(cfg.nodes.length);
    expect(diagram.note).toMatch(/omitted at the \d+-node cap/);
    // Truncation must not leave an edge pointing at a node that was dropped.
    for (const edge of parsed.edges) {
      expect(parsed.nodes.has(edge.from)).toBe(true);
      expect(parsed.nodes.has(edge.to)).toBe(true);
    }
  });
});

describe("toMarkdown", () => {
  it("fences the diagram and keeps the note outside it", async () => {
    const cfg = await cfgFor(`
      function f() {
        try { return risky(); } finally { cleanup(); }
      }
    `);
    const md = toMarkdown(cfg);
    const fenced = md.split("```mermaid")[1]!.split("```")[0]!;
    parseDiagram(fenced.trim());
    expect(md).toContain("### f");
    expect(md.trimEnd().endsWith(".")).toBe(true);
  });
});
