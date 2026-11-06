import { join } from "path";
import type { McpTool } from "../protocol.js";
import { describeRun, withStdoutProtected } from "../store.js";
import { bulletList, contains, enumArg, fenced, joinLines, loc, numberArg, offsetArg, OFFSET_SCHEMA, plural, stringArg } from "../format.js";
import { missHeadline, noResults } from "../empty.js";
import { requireAnalysis, type ToolContext } from "./context.js";
import type { Fact } from "../../core/fact-ids.js";

/**
 * The CLI commands that print something an agent asks for — `seq`, `export`,
 * `facts` and `diff` — as tools. Each answers from the analysis the store
 * serves (the one `loadReportSummary` reads), so a tool and its command can
 * never disagree; a command that writes files (`export --out-dir`, the
 * bundles) stays a command.
 */

/** Facts listed per page. */
const FACTS_PAGE = 60;
const FACT_KINDS: readonly Fact["kind"][] = ["route", "screen", "entity", "relation", "link", "access"];

/** `clarifydoc seq`: what a route or function does, in order, as a Mermaid sequence diagram. */
export function sequenceTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_sequence",
    title: "A route or function, in order",
    description: "Use for what a route or function does, in order: its calls, data access and HTTP hops as a Mermaid sequence diagram. `route` (\"POST /x\") or `symbol`.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string" },
        symbol: { type: "string" },
        file: { type: "string" },
        depth: { type: "number" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const route = stringArg(args, "route");
      const symbol = stringArg(args, "symbol");
      if (!route && !symbol) throw new Error('Pass `route` ("POST /api/clubs", or a path when it is unique) or `symbol` ("ClubService.create").');
      const loaded = await requireAnalysis(ctx);
      const { buildSequence, sequenceFiles, sequenceSeed } = await import("../../core/sequence.js");
      const { sequenceFrames } = await import("../../core/sequence-frames.js");
      const seed = sequenceSeed(loaded.summary, { route, symbol, file: stringArg(args, "file") });
      const base = args.depth === undefined ? {} : { depth: numberArg(args, "depth", 8, { min: 1, max: 30 }) };
      const frames = await sequenceFrames(ctx.store.projectRoot, sequenceFiles(loaded.summary, seed, base));
      const diagram = buildSequence(loaded.summary, seed, { ...base, frames });
      return {
        text: joinLines([
          `# ${seed.title} — in order (${loc(seed.file)})`,
          "An open-headed arrow is a call the linker only guessed; loop / alt / opt frames come from each function's control flow.",
          "",
          fenced(diagram.trimEnd(), "mermaid"),
        ]),
      };
    },
  };
}

/** `clarifydoc export`: one rendered document or diagram of the whole project. */
export function exportTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_export",
    title: "Project document or diagram",
    description: "Use for a whole-project document or diagram: ARCHITECTURE.md, DATA-MODEL.md, FLOWS.md, Mermaid, GraphML, Cypher, CSV. No `format` lists them.",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const { EXPORT_BUNDLES, EXPORT_FORMATS, findExportBundle, findExportFormat } = await import("../../export/index.js");
      const name = stringArg(args, "format");
      const catalogue = () => [
        ...EXPORT_FORMATS.map((f) => `- ${f.name} — ${f.description}`),
        ...EXPORT_BUNDLES.map((b) => `- ${b.name}/ — ${b.description} (a folder: \`clarifydoc export . --format ${b.name} --out-dir <dir>\` in a terminal)`),
      ];
      if (!name) return { text: joinLines(["# Export formats", "", ...catalogue(), "", 'Next: clarifydoc_export format="ARCHITECTURE.md"']) };
      const bundle = findExportBundle(name);
      if (bundle) {
        return {
          text: `${bundle.name} is a folder of files, not one document — write it from a terminal: \`clarifydoc export . --format ${bundle.name} --out-dir <dir>\`.`,
          isError: true,
        };
      }
      const format = findExportFormat(name);
      if (!format) throw new Error(`No export format "${name}". Formats:\n${catalogue().join("\n")}`);
      const loaded = await requireAnalysis(ctx);
      const body = format.render(loaded.summary as never).trimEnd();
      // Markdown reads as itself; anything else is a file's text, fenced so it cannot be read as markup.
      const lang = format.name.endsWith(".mmd") ? "mermaid" : format.name.split(".").pop() ?? "";
      return { text: format.name.endsWith(".md") ? body : joinLines([`# ${format.name}`, format.description, "", fenced(body, lang)]) };
    },
  };
}

/** `clarifydoc facts`: the analysis's facts under stable IDs, or the check of a text citing them. */
export function factsTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_facts",
    title: "Citable facts",
    description: "Use to cite facts in a document by stable ID ([R-3fa2c1]): lists them by `kind` and `query`, or `check`s the IDs a text cites.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...FACT_KINDS] },
        query: { type: "string" },
        check: { type: "string" },
        offset: OFFSET_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { checkCitations, factsOf } = await import("../../core/fact-ids.js");
      const facts = factsOf(loaded.summary);
      const factLine = (f: Fact) => `${f.id}  ${f.text}${f.file ? `  (${loc(f.file, f.line)})` : ""}`;
      const check = stringArg(args, "check");
      if (check !== undefined) {
        const cited = checkCitations(check, facts);
        if (!cited.length) return { text: `The text cites no fact IDs (the form is a letter and six hex digits, e.g. R-3fa2c1). The analysis holds ${plural(facts.size, "fact")}.` };
        const missing = cited.filter((c) => !c.fact);
        return {
          text: joinLines([
            missing.length ? `${missing.length} of ${cited.length} cited facts are not in the analysis.` : `All ${cited.length} cited facts are in the analysis.`,
            "",
            ...cited.map((c) => (c.fact ? `- ${factLine(c.fact)}` : `- ✗ ${c.id} (line ${c.line}) — no such fact in this analysis`)),
          ]),
        };
      }
      const kind = enumArg(args, "kind", FACT_KINDS);
      const query = stringArg(args, "query");
      const all = [...facts.values()];
      const matches = (f: Fact) => !query || contains(f.text, query) || contains(f.file, query);
      const rows = all.filter((f) => (!kind || f.kind === kind) && matches(f));
      if (!rows.length) {
        const queryAlone = kind && query ? all.filter(matches).length : 0;
        return {
          text: noResults({
            headline: missHeadline("facts", [["kind", kind], ["query", query]]),
            holds: `The analysis holds ${plural(all.length, "fact")}: ${FACT_KINDS.map((k) => `${all.filter((f) => f.kind === k).length} ${k}`).join(", ")}.`,
            next: [
              queryAlone ? `clarifydoc_facts query="${query}" without \`kind\` — ${queryAlone} match` : undefined,
              query ? `clarifydoc_search query="${query}" — the names the analysis holds` : `clarifydoc_facts without \`kind\``,
            ],
          }),
        };
      }
      return {
        text: joinLines([
          `# Facts${kind ? ` (${kind})` : ""}${query ? ` matching "${query}"` : ""}: ${rows.length}`,
          "Cite one as [ID]; check a draft with `check`.",
          "",
          ...bulletList(rows, FACTS_PAGE, factLine, { offset: offsetArg(args) }),
        ]),
      };
    },
  };
}

/**
 * `clarifydoc diff --base <ref>`: the API surface of the working tree's
 * analysis against the project at a git ref. The ref is analyzed once in a
 * temporary worktree and kept beside the analysis, seeded from it so only the
 * files that differ reparse; a run past the call deadline goes on, and the
 * next call for the same ref joins it.
 */
export function diffTool(ctx: ToolContext): McpTool {
  const runs = new Map<string, Promise<{ dir: string; commit: string }>>();
  return {
    name: "clarifydoc_diff",
    title: "API surface diff",
    description: "Use for how the API surface changed since git `base` (default HEAD): routes, parameters, bodies, guards, links, data reached — breaking or risky.",
    inputSchema: {
      type: "object",
      properties: { base: { type: "string" } },
      additionalProperties: false,
    },
    readOnly: false,
    handler: async (args) => {
      const ref = stringArg(args, "base") ?? "HEAD";
      if (!ctx.store.allowAnalyze && !runs.has(ref)) {
        return {
          text: `This server is read-only (--no-auto-analyze), and comparing with ${ref} needs an analysis of it. Run \`clarifydoc diff --base ${ref}\` in a terminal.`,
          isError: true,
        };
      }
      const head = await requireAnalysis(ctx);
      let run = runs.get(ref);
      if (!run) {
        const { analysisAtRef } = await import("../../core/base-ref.js");
        const { store } = ctx;
        run = withStdoutProtected(store.log, () =>
          analysisAtRef(store.projectRoot, ref, { headAnalysisDir: store.analysisDir, cacheBase: join(store.analysisDir, ".base"), log: store.log }),
        );
        runs.set(ref, run);
        void run.finally(() => runs.delete(ref)).catch(() => {});
      }
      const outcome = await ctx.store.waitWithin(run);
      if ("pending" in outcome) {
        return {
          text: `The analysis of ${ref} is still running (${describeRun(outcome.pending)}); it goes on in the background. Call clarifydoc_diff base="${ref}" again to wait for this same run.`,
        };
      }
      const { loadReportSummary } = await import("../../core/report-payload.js");
      const { diffSurface, renderSurfaceText } = await import("../../core/surface-diff.js");
      const base = await loadReportSummary(outcome.done.dir);
      const d = diffSurface(base, head.summary);
      return {
        text: joinLines([
          `# API surface: ${ref} (${outcome.done.commit.slice(0, 12)}) → the working tree's analysis`,
          "",
          renderSurfaceText(d).trimEnd(),
          d.counts.total ? "\nNext: clarifydoc_impact — the screens, routes and tests the edit reaches" : "",
        ]),
      };
    },
  };
}
