import { readFile } from "fs/promises";
import { extname } from "path";
import type { Language } from "../types/analysis.js";
import type { Cfg } from "../types/control-flow.js";
import {
  EXTENSION_TO_LANGUAGE,
  controlFlowFor,
  ensureLanguagesLoaded,
  manifestFor,
  pluginFor,
} from "../extractors/registry.js";
import { extractClasses, extractFunctions } from "../extractors/functions-classes/index.js";
import { parseSource, type TreeSitterLanguage } from "../parsers/parser-manager.js";
import { computeComplexity } from "./complexity-analyzer.js";
import { buildControlFlow } from "./control-flow.js";

/**
 * Build control-flow graphs for the functions of one file, on demand.
 *
 * The seam between `clarifydoc cfg` (and anything else that wants a CFG) and
 * the builder. It deliberately does NOT go through `analyzeFile`: that writes
 * per-file JSON and is part of the pipeline, whereas this reads one file and
 * writes nothing. What it does share is `computeComplexity`, which is where
 * the function list and its naming (`Class.method`) come from — so the CFG is
 * always built for exactly the rows the Complexity tab and `clarifydoc_file`
 * show, and a name that works in one works in the other.
 */

export interface ControlFlowRequest {
  /** Absolute path to the file to read. */
  filePath: string;
  /** Path to record in the result; defaults to `filePath`. */
  displayPath?: string;
  /** Select by function name, as the complexity rows spell it. */
  functionName?: string;
  /** Select the function whose body covers this 1-based line. */
  line?: number;
}

export interface ControlFlowFileResult {
  filePath: string;
  language: Language;
  /** Graphs for the selected functions, in source order. */
  cfgs: Cfg[];
  /**
   * Every function the file offers, with its complexity — what to print when
   * the selector matched nothing, so the caller can choose.
   */
  available: { functionName: string; line: number; endLine: number; complexity: number }[];
}

export class ControlFlowUnavailableError extends Error {}

/**
 * Which languages can have their control flow drawn, and the file extensions
 * that reach them.
 *
 * Published so a caller can tell before it offers the action — the VS Code
 * CodeLens uses it to send the flame lens to the Complexity report instead of
 * to a view that would only say "not for this language". Derived from the
 * registry rather than listed, so a plugin gaining a `controlFlow` spec turns
 * the feature on everywhere without a second edit.
 */
export async function controlFlowCapabilities(): Promise<{
  languages: string[];
  extensions: string[];
}> {
  // `parsing` is on the eagerly-loaded manifest, so the AST languages can be
  // narrowed down before anything is loaded; `controlFlow` lives in the lazy
  // plugin body, so only those few are brought in to be asked.
  const candidates = [...new Set(Object.values(EXTENSION_TO_LANGUAGE))].filter(
    (language) => manifestFor(language)?.parsing === "tree-sitter",
  );
  await ensureLanguagesLoaded(candidates);

  const languages = new Set<string>();
  const extensions = new Set<string>();
  for (const [extension, language] of Object.entries(EXTENSION_TO_LANGUAGE)) {
    if (!candidates.includes(language) || !controlFlowFor(language)) continue;
    languages.add(language);
    extensions.add(extension);
  }
  return { languages: [...languages].sort(), extensions: [...extensions].sort() };
}

function languageOf(filePath: string): Language | undefined {
  return EXTENSION_TO_LANGUAGE[extname(filePath).toLowerCase()];
}

/**
 * Accept the bare method name as well as the `Class.method` the complexity
 * rows use, because the bare one is what a reader has under the cursor.
 */
function matchesName(rowName: string, wanted: string): boolean {
  return rowName === wanted || rowName.slice(rowName.lastIndexOf(".") + 1) === wanted;
}

export async function controlFlowForFile(
  request: ControlFlowRequest,
): Promise<ControlFlowFileResult> {
  const { filePath, displayPath = filePath, functionName, line } = request;

  const language = languageOf(filePath);
  if (!language) {
    throw new ControlFlowUnavailableError(`No language is registered for ${extname(filePath)} files.`);
  }
  await ensureLanguagesLoaded([language]);
  if (!controlFlowFor(language)) {
    throw new ControlFlowUnavailableError(
      `${language} has no control-flow tables yet — its complexity numbers are computed, but not explained. See meta.controlFlow in the language plugin.`,
    );
  }

  const plugin = pluginFor(language);
  if (plugin?.parsing !== "tree-sitter") {
    throw new ControlFlowUnavailableError(
      `${language} is extracted without an AST, so there is no control flow to read.`,
    );
  }
  const raw = await readFile(filePath, plugin.sourceEncoding ?? "utf-8");

  // Container formats (a Vue or Svelte SFC) carry their code in a `<script>`
  // block, and the whole pipeline reads them through this hook. Skipping it
  // would parse the markup as TypeScript and draw a graph of the wreckage.
  let source = raw;
  let effective = language;
  const pre = plugin.preprocess?.(raw, displayPath);
  if (pre) {
    if ("skip" in pre) {
      throw new ControlFlowUnavailableError(`${displayPath} has no code to draw: ${pre.skip}`);
    }
    source = pre.sourceText;
    effective = pre.language;
    await ensureLanguagesLoaded([effective]);
  }

  // Narrowed by the `parsing` check above: only tree-sitter languages get here.
  const tree = await parseSource(source, effective as TreeSitterLanguage, filePath);

  const functions = extractFunctions(tree, source, effective);
  const classes = extractClasses(tree, source, effective);
  const rows = computeComplexity(tree, effective, functions, classes).sort((a, b) => a.line - b.line);

  const selected = rows.filter((row) => {
    if (functionName !== undefined && !matchesName(row.functionName, functionName)) return false;
    if (line !== undefined && (line < row.line || line > row.endLine)) return false;
    return true;
  });

  // Both selectors given and nothing matching both means the caller's idea of
  // the file is out of date — a CodeLens carries the name and the line from
  // the same stored analysis, and an edit above the function moves the line
  // while leaving the name right. So the name is tried alone first, and the
  // line only when there was no name to go on.
  const rowsToBuild =
    selected.length > 0
      ? selected
      : functionName !== undefined
        ? rows.filter((row) => matchesName(row.functionName, functionName))
        : line !== undefined
          ? rows.filter((row) => line >= row.line && line <= row.endLine)
          : [];

  // Innermost first: a cursor inside a nested function matches both it and its
  // enclosing function, and the inner one is what the reader is looking at.
  const ordered = [...rowsToBuild].sort(
    (a, b) => a.endLine - a.line - (b.endLine - b.line),
  );

  const cfgs: Cfg[] = [];
  for (const row of ordered) {
    const cfg = buildControlFlow(
      tree,
      language,
      { name: row.functionName, line: row.line, endLine: row.endLine },
      displayPath,
    );
    if (cfg) cfgs.push(cfg);
  }

  return {
    filePath: displayPath,
    language,
    cfgs,
    available: rows.map((row) => ({
      functionName: row.functionName,
      line: row.line,
      endLine: row.endLine,
      complexity: row.complexity,
    })),
  };
}
