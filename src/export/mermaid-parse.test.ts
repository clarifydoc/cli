import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { loadReportSummary } from "../core/report-payload.js";
import { buildSequence, routeAnchor } from "../core/sequence.js";
import { ControlFlowUnavailableError, controlFlowForFile } from "../core/control-flow-file.js";
import { toMermaidFlowchart } from "../core/control-flow-mermaid.js";
import { EXPORT_FORMATS, renderExport } from "./index.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Every Mermaid document the tool writes goes through Mermaid's own parser.
 *
 * The other diagram tests re-read the text with a validator of their own,
 * which catches the shapes they know about; a label that Mermaid's grammar
 * reads differently (a keyword, an unbalanced bracket, a reserved id) passes
 * them and fails on GitHub. Here the authority is the real grammar.
 *
 * Mermaid runs in node without a DOM except for one thing: it registers a
 * sanitizer hook on DOMPurify at load, and DOMPurify without a window has no
 * methods. Sanitizing is part of rendering, not of the grammar, so the hook
 * is stubbed out before Mermaid loads.
 */

type Parse = (text: string) => Promise<{ diagramType: string } | false>;
let parse: Parse;

beforeAll(async () => {
  const { default: purify } = (await import("dompurify")) as unknown as { default: Record<string, unknown> };
  purify.addHook ??= () => {};
  purify.removeHook ??= () => {};
  purify.removeHooks ??= () => {};
  purify.sanitize ??= (text: string) => text;
  const { default: mermaid } = await import("mermaid");
  parse = (text) => mermaid.parse(text) as Promise<{ diagramType: string } | false>;
}, 60_000);

/** Parse one document; on failure, say where it came from and show the text. */
async function expectParses(text: string, where: string): Promise<string> {
  try {
    const result = await parse(text);
    expect(result, where).toBeTruthy();
    return (result as { diagramType: string }).diagramType;
  } catch (error) {
    throw new Error(`${where}: Mermaid rejected the document\n${(error as Error).message}\n--- document ---\n${text}`);
  }
}

/** The ```mermaid fences of a Markdown document. */
function fences(markdown: string): string[] {
  return [...markdown.matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);
}

const OUTPUT = resolve(__dirname, "../../test-output");
const fixtures = existsSync(OUTPUT)
  ? readdirSync(OUTPUT)
      .filter((name) => existsSync(join(OUTPUT, name, "project-summary.json")))
      .sort()
  : [];

describe("Mermaid exports parse", () => {
  const summaries = new Map<string, ProjectAnalysis>();
  beforeAll(async () => {
    for (const name of fixtures) summaries.set(name, await loadReportSummary(join(OUTPUT, name)));
  }, 120_000);

  it("finds the fixture analyses", () => {
    expect(fixtures.length).toBeGreaterThan(20);
  });

  it("every .mmd export and every Mermaid fence in a Markdown export, on every fixture", async () => {
    const diagrams = EXPORT_FORMATS.filter((f) => f.name.endsWith(".mmd"));
    const documents = EXPORT_FORMATS.filter((f) => f.name.endsWith(".md"));
    expect(diagrams.length).toBeGreaterThan(3);
    const kinds = new Set<string>();
    let parsed = 0;
    for (const [name, summary] of summaries) {
      for (const f of diagrams) {
        const text = renderExport(f.name, summary);
        // An empty diagram is a comment saying why; there is nothing to draw.
        if (!text.split("\n").some((line) => line.trim() && !line.startsWith("%%"))) continue;
        kinds.add(await expectParses(text, `${name}/${f.name}`));
        parsed++;
      }
      for (const f of documents) {
        for (const [i, block] of fences(renderExport(f.name, summary)).entries()) {
          kinds.add(await expectParses(block, `${name}/${f.name} fence ${i + 1}`));
          parsed++;
        }
      }
    }
    expect(parsed).toBeGreaterThan(100);
    // The four diagram kinds draw as flowcharts and an ER diagram; a writer that
    // stopped emitting one of them would quietly stop being checked.
    expect([...kinds].sort()).toEqual(expect.arrayContaining(["er", "flowchart-v2"]));
  }, 300_000);

  it("route sequence diagrams", async () => {
    let parsed = 0;
    for (const [name, summary] of summaries) {
      const routes = (summary.routeMap ?? []).filter((r) => r.filePath).slice(0, 6);
      for (const r of routes) {
        const anchor = routeAnchor(r, summary.symbolLinks ?? []);
        if (!anchor) continue;
        const title = `${r.httpMethod ?? ""} ${r.path}`.trim();
        for (const lanes of ["class", "package"] as const) {
          const text = buildSequence(summary, { file: r.filePath!, symbol: anchor, title }, { lanes });
          expect(await expectParses(text, `${name} ${title} (${lanes})`)).toBe("sequence");
          parsed++;
        }
      }
    }
    expect(parsed).toBeGreaterThan(50);
  }, 300_000);
});

describe("control-flow flowcharts parse", () => {
  // The largest fixture file of each extension: every tree-sitter control-flow
  // table, and the regex tier with both brace counting and keyword blocks.
  const EXTENSIONS = ["ts", "tsx", "js", "vue", "py", "java", "kt", "cs", "php", "pas", "go", "rs", "rb", "c", "cpp", "swift", "dart", "pl", "ex", "vb"];
  const root = resolve(__dirname, "../../test-fixtures");

  function largestOf(extension: string): string | undefined {
    let best: { path: string; size: number } | undefined;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(`.${extension}`)) {
          const size = statSync(path).size;
          if (!best || size > best.size || (size === best.size && path < best.path)) best = { path, size };
        }
      }
    };
    walk(root);
    return best?.path;
  }

  it("every function of a file in each language, with and without the colour table", async () => {
    const files = EXTENSIONS.map(largestOf).filter((f): f is string => !!f);
    expect(files.length).toBeGreaterThan(15);
    let parsed = 0;
    for (const file of files) {
      let cfgs;
      try {
        ({ cfgs } = await controlFlowForFile({ filePath: file, displayPath: relative(root, file) }));
      } catch (error) {
        if (error instanceof ControlFlowUnavailableError) continue;
        throw error;
      }
      for (const cfg of cfgs) {
        for (const classDefs of [true, false]) {
          const { text } = toMermaidFlowchart(cfg, { classDefs });
          expect(await expectParses(text, `${relative(root, file)} ${cfg.functionName}`)).toBe("flowchart-v2");
          parsed++;
        }
      }
    }
    expect(parsed).toBeGreaterThan(100);
  }, 120_000);
});
