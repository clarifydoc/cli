import { readFile } from "fs/promises";
import { join } from "path";
import type { McpTool } from "../protocol.js";
import { joinLines, numberArg, requiredStringArg, stringArg } from "../format.js";
import { mustResolveFile, requireAnalysis, type ToolContext } from "./context.js";
import { noResults } from "../empty.js";

/** Functions listed when the file has several and none was named. */
const MAX_LISTED = 30;

/**
 * `clarifydoc_control_flow`: one function's control flow as Mermaid — the
 * structure behind its complexity number — or, with `slice`, the statements
 * that can affect the values used at a line (a backward slice). What
 * `clarifydoc cfg` prints, for an agent: it reads the file as it is now.
 */
export function controlFlowTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_control_flow",
    title: "A function's control flow, or a backward slice",
    description:
      "One function's control flow as a Mermaid flowchart (its branches, loops and exits), or with `slice` the " +
      "statements that can affect the values used at that line. Name the function, or a line inside it.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Project-relative path." },
        function: { type: "string", description: "`Class.method` or the bare name." },
        line: { type: "number", description: "A 1-based line inside the function." },
        slice: { type: "number", description: "A 1-based line: list what can affect the values used there instead." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const rel = mustResolveFile(loaded, requiredStringArg(args, "file"));
      const abs = join(ctx.store.projectRoot, rel);
      const functionName = stringArg(args, "function");
      const sliceLine = args.slice === undefined ? undefined : numberArg(args, "slice", 1, { max: 10_000_000 });
      const line = args.line === undefined ? sliceLine : numberArg(args, "line", 1, { max: 10_000_000 });
      const [{ controlFlowForFile }, { toMermaidFlowchart }] = await Promise.all([import("../../core/control-flow-file.js"), import("../../core/control-flow-mermaid.js")]);
      const result = await controlFlowForFile({ filePath: abs, displayPath: rel, functionName, line });
      const listing = result.available.slice(0, MAX_LISTED).map((f) => `${f.functionName} (lines ${f.line}-${f.endLine}, complexity ${f.complexity})`);
      if (result.cfgs.length === 0) {
        return {
          text: noResults({
            headline: functionName || line ? `No function in ${rel} matches${functionName ? ` "${functionName}"` : ""}${line ? ` at line ${line}` : ""}.` : `Nothing in ${rel} has a body to draw.`,
            holds: listing.length ? `Functions here: ${listing.join("; ")}` : undefined,
            next: [result.available[0] && `clarifydoc_control_flow file="${rel}" function="${result.available[0].functionName}"`],
          }),
        };
      }
      if (result.cfgs.length > 1) {
        return {
          text: joinLines([
            `${rel} has ${result.cfgs.length} functions — name one (\`function\`) or a line inside it (\`line\`):`,
            ...listing.map((l) => `- ${l}`),
            result.available.length > MAX_LISTED ? `  … ${result.available.length - MAX_LISTED} more` : "",
          ]),
        };
      }
      const cfg = result.cfgs[0]!;
      const approx = cfg.approximate ? " — approximate: read off the text, this language has no parse tree here" : "";
      if (sliceLine !== undefined) {
        const { backwardSlice } = await import("../../core/control-flow-slice.js");
        const slice = backwardSlice(cfg, (await readFile(abs, "utf-8")).split(/\r?\n/), sliceLine);
        if (!slice) return { text: `No statement of ${cfg.functionName} covers line ${sliceLine} (it spans ${cfg.line}-${cfg.endLine}).`, isError: true };
        return {
          text: joinLines([
            `# Backward slice of ${cfg.functionName} at ${rel}:${sliceLine}${approx}`,
            slice.variables.length ? `values used there: ${slice.variables.join(", ")}` : "",
            "",
            ...slice.statements.map((s) => `- ${rel}:${s.line}  ${s.text.split("\n")[0]}${s.text.includes("\n") ? " …" : ""}  (${s.why})`),
            slice.fromOutside.length ? `\nFrom parameters or the enclosing scope: ${slice.fromOutside.join(", ")}` : "",
          ]),
        };
      }
      const diagram = toMermaidFlowchart(cfg, { classDefs: false });
      return {
        text: joinLines([
          `# Control flow of ${cfg.functionName} (${rel}:${cfg.line}-${cfg.endLine})${approx}`,
          diagram.note ?? "",
          "",
          "```mermaid",
          diagram.text.trimEnd(),
          "```",
        ]),
      };
    },
  };
}
