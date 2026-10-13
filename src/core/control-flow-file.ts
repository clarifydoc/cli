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
  regexControlFlowFor,
} from "../extractors/registry.js";
import { extractClasses, extractFunctions } from "../extractors/functions-classes/index.js";
import { parseSource, type TreeSitterLanguage } from "../parsers/parser-manager.js";
import { computeComplexity } from "./complexity-analyzer.js";
import { buildControlFlow, type FunctionRef } from "./control-flow.js";
import { buildRegexControlFlow } from "./control-flow-regex.js";
import { extractWithRegex } from "./regex-extractor.js";

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
  /**
   * The file's text, when it is not what is on disk — an editor's unsaved
   * buffer. `filePath` still names the language and the file; without this the
   * file is read from `filePath`.
   */
  source?: string;
}

/** The graphs drawn for one file plus the list of functions it could have drawn. */
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

/**
 * Thrown when no graph can be drawn for a file: its extension is unregistered,
 * its language has no control-flow tables, or the file holds no code (a `.vue`
 * without a `<script>` block). The message is written for the end user.
 */
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
export interface ControlFlowCapabilities {
  /** Every language that can be drawn, by either tier. */
  languages: string[];
  /** Every file extension that reaches one of them. */
  extensions: string[];
  /**
   * The subset drawn by reading the source text rather than a parse tree. A
   * caller that offers the action should say so; the graphs themselves are
   * marked `approximate` too.
   */
  approximate: string[];
}

/**
 * Enumerate the languages and extensions that `controlFlowForFile` can serve.
 *
 * Loads every plugin whose manifest might carry a control-flow spec, so the
 * first call is comparatively slow; the answer only changes when plugins do.
 *
 * @returns The drawable languages, their extensions and the approximate subset
 */
export async function controlFlowCapabilities(): Promise<ControlFlowCapabilities> {
  // `parsing` is on the eagerly-loaded manifest, so the formats with no code
  // at all are dropped before anything is loaded; the two control-flow specs
  // live in the lazy plugin body, so the rest are brought in to be asked.
  const candidates = [...new Set(Object.values(EXTENSION_TO_LANGUAGE))].filter(
    (language) => manifestFor(language)?.parsing !== "custom",
  );
  await ensureLanguagesLoaded(candidates);

  const languages = new Set<string>();
  const extensions = new Set<string>();
  const approximate = new Set<string>();
  for (const [extension, language] of Object.entries(EXTENSION_TO_LANGUAGE)) {
    if (!candidates.includes(language)) continue;
    const exact = manifestFor(language)?.parsing === "tree-sitter" && controlFlowFor(language);
    const loose = !exact && regexControlFlowFor(language);
    if (!exact && !loose) continue;
    languages.add(language);
    extensions.add(extension);
    if (loose) approximate.add(language);
  }
  return {
    languages: [...languages].sort(),
    extensions: [...extensions].sort(),
    approximate: [...approximate].sort(),
  };
}

/** The registered language for a file's extension, or undefined. */
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

/**
 * Pick the functions a name and/or a line select, in the order to draw them.
 *
 * Shared by both tiers so the two cannot disagree about what "the function the
 * cursor is in" means.
 */
function selectRows(
  rows: readonly FunctionRef[],
  functionName: string | undefined,
  line: number | undefined,
): FunctionRef[] {
  const both = rows.filter((row) => {
    if (functionName !== undefined && !matchesName(row.name, functionName)) return false;
    if (line !== undefined && (line < row.line || line > row.endLine)) return false;
    return true;
  });

  // Both selectors given and nothing matching both means the caller's idea of
  // the file is out of date — a CodeLens carries the name and the line from
  // the same stored analysis, and an edit above the function moves the line
  // while leaving the name right. So the name is tried alone first, and the
  // line only when there was no name to go on.
  const chosen =
    both.length > 0
      ? both
      : functionName !== undefined
        ? rows.filter((row) => matchesName(row.name, functionName))
        : line !== undefined
          ? rows.filter((row) => line >= row.line && line <= row.endLine)
          : [];

  // Innermost first: a cursor inside a nested function matches both it and its
  // enclosing function, and the inner one is what the reader is looking at.
  return [...chosen].sort((a, b) => a.endLine - a.line - (b.endLine - b.line));
}

/**
 * Read one source file and build control-flow graphs for its functions.
 *
 * Selection: `functionName` picks by the name the complexity rows use
 * (`Class.method` for methods), `line` picks every function whose body covers
 * that line, innermost first; with neither, every function is drawn. Nothing
 * is written to disk. Tree-sitter languages get exact graphs; regex-only
 * languages get `approximate` ones with no complexity figures.
 *
 * @param request - The file and the optional selector
 * @returns The selected graphs and every function available in the file
 * @throws ControlFlowUnavailableError when the file cannot be drawn at all
 */
export async function controlFlowForFile(
  request: ControlFlowRequest,
): Promise<ControlFlowFileResult> {
  const { filePath, displayPath = filePath, functionName, line, source: given } = request;

  const language = languageOf(filePath);
  if (!language) {
    throw new ControlFlowUnavailableError(`No language is registered for ${extname(filePath)} files.`);
  }
  await ensureLanguagesLoaded([language]);
  const plugin = pluginFor(language);

  // No parse tree for this language: read the control flow off the text
  // instead. An approximation, marked as one everywhere it surfaces.
  if (plugin?.parsing !== "tree-sitter") {
    return regexFallback(filePath, displayPath, language, functionName, line, given);
  }
  if (!controlFlowFor(language)) {
    throw new ControlFlowUnavailableError(
      `${language} has no control-flow tables yet — its complexity numbers are computed, but not explained. See meta.controlFlow in the language plugin.`,
    );
  }
  const raw = given ?? (await readFile(filePath, plugin.sourceEncoding ?? "utf-8"));

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

  const cfgs: Cfg[] = [];
  for (const row of selectRows(
    rows.map((r) => ({ name: r.functionName, line: r.line, endLine: r.endLine })),
    functionName,
    line,
  )) {
    const cfg = buildControlFlow(tree, language, row, displayPath);
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


/**
 * The regex tier's path to a graph.
 *
 * It shares nothing with the tree-sitter path except its destination, because
 * it has nothing to share: no tree to search for the body, and no complexity
 * rows to name the functions. Both come from the regex extractor instead,
 * which already reports every function with accurate start and end lines —
 * that is the whole reason this is possible at all.
 */
async function regexFallback(
  filePath: string,
  displayPath: string,
  language: Language,
  functionName: string | undefined,
  line: number | undefined,
  given: string | undefined,
): Promise<ControlFlowFileResult> {
  if (!regexControlFlowFor(language)) {
    throw new ControlFlowUnavailableError(
      `${language} has no control-flow tables yet — neither a grammar nor the source patterns the regex tier needs. See meta.regexControlFlow in the language plugin.`,
    );
  }

  const source = given ?? (await readFile(filePath, pluginFor(language)?.sourceEncoding ?? "utf-8"));
  const analysis = extractWithRegex(source, displayPath, language);

  const rows = [
    ...analysis.functions.map((f) => ({ name: f.name, line: f.line, endLine: f.endLine })),
    ...analysis.classes.flatMap((c) =>
      c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine })),
    ),
  ]
    .filter((row) => row.name !== "<setup>" && row.endLine > row.line)
    .sort((a, b) => a.line - b.line);

  const selected = selectRows(rows, functionName, line);
  const cfgs: Cfg[] = [];
  for (const row of selected) {
    const cfg = buildRegexControlFlow(source, language, row, displayPath);
    if (cfg) cfgs.push(cfg);
  }

  return {
    filePath: displayPath,
    language,
    cfgs,
    available: rows.map((row) => ({
      functionName: row.name,
      line: row.line,
      endLine: row.endLine,
      // The regex tier computes no complexity, so there is no number to show
      // rather than a wrong one.
      complexity: 0,
    })),
  };
}
