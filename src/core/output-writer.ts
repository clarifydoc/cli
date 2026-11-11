import { writeFile, mkdir, access } from "fs/promises";
import { mkdirSync, writeFileSync } from "fs";
import { resolve, dirname, join, relative, isAbsolute } from "path";
import type {
  FileAnalysis,
  ProjectAnalysis,
  LspStats,
  SymbolLink,
  BlastRadiusInfo,
  LinkInfo,
  LspDefinitionRecord,
  LspReferenceRecord,
  LspImplementationRecord,
} from "../types/analysis.js";
import { validateFileAnalysis } from "./fileanalysis-validator.js";
import { normalizeProject } from "./element-registry.js";
import type { ImpactDiffResult } from "./impact-diff.js";

/**
 * LSP enhancement delta — written as a SEPARATE file from the base summary
 * so that `analyze --no-lsp` and `lsp-update` can run independently in parallel.
 * When an HTML report is generated, it merges this delta onto the base summary.
 */
export interface LspEnhancement {
  /** Merged symbolLinks (text + LSP) — full replacement of base summary's field. */
  symbolLinks: SymbolLink[];
  /** Enriched componentGraph (base edges + edges derived from new symbolLinks). */
  componentGraph: Record<string, string[]>;
  /** Enriched linkGraph matching componentGraph. */
  linkGraph: LinkInfo[];
  /** Recomputed blast radius (depends on enriched graph + symbolLinks). */
  blastRadius: BlastRadiusInfo[];
  /** Stats describing LSP servers used and counts. */
  lspStats: LspStats;
  /** ISO timestamp of when the enhancement was produced. */
  enhancedAt: string;
  /**
   * The links layer 2 added, and the content hash (manifest SHA-256) of every
   * file they touch, as of this run. When the summary is re-analyzed after the
   * delta, the links whose files still hash the same carry over; the rest of
   * the delta describes code that has since changed and is left out.
   */
  added?: { links: SymbolLink[]; files: Record<string, string> };
}

/**
 * Raw LSP query/answer log — written as a SEPARATE file from the merged links
 * so the text-based linker can be optimized against it: re-run text analysis,
 * then compare its links to these records. Unlike
 * `lsp-enhancement.json`, this keeps pre-redirect targets and unresolved
 * queries, which the merged output loses.
 */
export interface LspGroundTruth {
  schemaVersion: 1;
  projectRoot: string;
  serversUsed: string[];
  stats: {
    definitionQueries: number;
    definitionsResolved: number;
    definitionsUnresolved: number;
    referenceQueries: number;
    referencesFound: number;
    enhancementTimeMs: number;
  };
  definitions: LspDefinitionRecord[];
  references: LspReferenceRecord[];
  /** Implementations at the calls dependency injection left on an interface (ground truth for its refusals). */
  implementations?: LspImplementationRecord[];
  generatedAt: string;
}

/** Where per-file JSON and summaries are written, and whether to indent them. */
export interface OutputOptions {
  outputDir: string;
  pretty?: boolean;
}

/**
 * Keep a project-local analysis out of git without touching the user's own
 * .gitignore: drop a `.gitignore` containing `*` INTO the analysis directory, so
 * it ignores itself and everything beside it. Git then reports no untracked
 * files there at all, and VS Code's search and Quick Open skip it too.
 *
 * Only written when the analysis actually lives inside the project (the VS Code
 * extension can put it in its own private storage instead, where a marker would
 * be pointless), and only when absent — emptying the file is how a team opts
 * into committing the analysis so teammates and CI agents get the map with no
 * scan of their own.
 */
export async function ensureSelfIgnored(outputDir: string, projectRoot: string): Promise<void> {
  const rel = relative(resolve(projectRoot), resolve(outputDir));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;

  const marker = join(resolve(outputDir), ".gitignore");
  try {
    await access(marker);
    return; // already there (possibly emptied on purpose) — never overwrite
  } catch {
    // not there yet
  }
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(
    marker,
    [
      "# ClarifyDoc keeps this project's analysis here so the CLI, the VS Code",
      "# extension and any MCP client read one copy. This file makes the whole",
      "# directory — itself included — invisible to git.",
      "#",
      "# To commit the analysis instead, so teammates and CI agents get the map",
      "# without scanning, empty this file: ClarifyDoc only writes it when absent.",
      "*",
      "",
    ].join("\n"),
    "utf-8",
  );
}

/** Where one file's analysis is kept: `<outputDir>/<relativePath>.json`. */
export function fileAnalysisPath(filePath: string, options: OutputOptions): string {
  return resolve(options.outputDir, `${filePath}.json`);
}

/**
 * One file's analysis as the JSON text its output file holds.
 *
 * Runs schema validation once per file. Warnings are collected, not thrown —
 * an extractor producing malformed output should still produce visible output
 * with the issue flagged inline.
 */
export function serializeFileAnalysis(analysis: FileAnalysis, options: OutputOptions): string {
  const warnings = validateFileAnalysis(analysis);
  if (warnings.length > 0) {
    analysis.extractorWarnings = warnings;
  }
  return options.pretty ? JSON.stringify(analysis, null, 2) : JSON.stringify(analysis);
}

/**
 * Write one output file, making its directory when it is not there yet. The
 * directory exists for every file but the first one written into it, so the
 * file is written first and the directory made only on a miss.
 */
export async function writeOutputFile(outPath: string, data: string | Uint8Array): Promise<void> {
  try {
    await writeFile(outPath, data, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, data, "utf-8");
  }
}

/** One output file to write: its bytes, where they go, and the key its writer answers a failure under. */
export interface OutputFile {
  key: string;
  path: string;
  data: Uint8Array;
}

/** A batch of output files for one thread to write (a pool task: `file` says what it is when a worker dies on it). */
export interface OutputWriteTask {
  file: { relativePath: string };
  write: OutputFile[];
}

/** The files of a batch that could not be written. */
export interface OutputWriteResult {
  unwritten: Array<{ key: string; error: string }>;
}

/**
 * Write a batch of output files one after the other, on the calling thread,
 * making a directory when it is not there yet. This is what a worker thread
 * runs: it has nothing else in hand, so nothing waits on its event loop.
 */
export function writeOutputFilesSync(files: readonly OutputFile[]): OutputWriteResult {
  const unwritten: OutputWriteResult["unwritten"] = [];
  for (const file of files) {
    try {
      // Bytes handed to another thread and back are gone from this one: an analysis is never empty.
      if (file.data.byteLength === 0) throw new Error("its JSON was handed to a worker that died");
      try {
        writeFileSync(file.path, file.data);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.data);
      }
    } catch (err) {
      unwritten.push({ key: file.key, error: (err as Error).message });
    }
  }
  return { unwritten };
}

/**
 * Write a single file analysis result as JSON.
 * Creates: <outputDir>/<relativePath>.json
 */
export async function writeFileAnalysis(
  analysis: FileAnalysis,
  options: OutputOptions,
): Promise<string> {
  const outPath = fileAnalysisPath(analysis.filePath, options);
  await writeOutputFile(outPath, serializeFileAnalysis(analysis, options));
  return outPath;
}

/** Write a fixed-name JSON artifact into the output dir. */
async function writeJson(
  fileName: string,
  data: unknown,
  options: OutputOptions,
): Promise<string> {
  const outPath = join(resolve(options.outputDir), fileName);
  await mkdir(dirname(outPath), { recursive: true });

  const json = options.pretty
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);

  await writeFile(outPath, json, "utf-8");
  return outPath;
}

/**
 * Write the project-level summary.
 * Creates: <outputDir>/project-summary.json
 */
export async function writeProjectSummary(
  summary: ProjectAnalysis,
  options: OutputOptions,
): Promise<string> {
  return writeJson("project-summary.json", normalizeProject(summary), options);
}

/**
 * Write the diff-scoped impact of the latest incremental run.
 * Creates: <outputDir>/impact-latest.json
 */
export async function writeImpactDiff(
  impact: ImpactDiffResult,
  options: OutputOptions,
): Promise<string> {
  return writeJson("impact-latest.json", impact, options);
}

/**
 * Write the LSP enhancement delta.
 * Creates: <outputDir>/lsp-enhancement.json
 */
export async function writeLspEnhancement(
  enhancement: LspEnhancement,
  options: OutputOptions,
): Promise<string> {
  return writeJson("lsp-enhancement.json", enhancement, options);
}

/** The slice of an LSP enhancement result the ground-truth export needs. */
export interface LspGroundTruthInput {
  serversUsed: string[];
  timeMs: number;
  definitionRecords: LspDefinitionRecord[];
  referenceRecords: LspReferenceRecord[];
  implementationRecords?: LspImplementationRecord[];
}

/**
 * Assemble and write the raw LSP query/answer log from an enhancement run.
 * Creates: <outputDir>/lsp-ground-truth.json
 */
export async function writeLspGroundTruth(
  projectRoot: string,
  result: LspGroundTruthInput,
  options: OutputOptions,
): Promise<string> {
  const resolved = result.definitionRecords.filter((r) => r.target !== null).length;
  const groundTruth: LspGroundTruth = {
    schemaVersion: 1,
    projectRoot,
    serversUsed: result.serversUsed,
    stats: {
      definitionQueries: result.definitionRecords.length,
      definitionsResolved: resolved,
      definitionsUnresolved: result.definitionRecords.length - resolved,
      referenceQueries: result.referenceRecords.length,
      referencesFound: result.referenceRecords.reduce((n, r) => n + r.references.length, 0),
      enhancementTimeMs: result.timeMs,
    },
    definitions: result.definitionRecords,
    references: result.referenceRecords,
    ...(result.implementationRecords?.length ? { implementations: result.implementationRecords } : {}),
    generatedAt: new Date().toISOString(),
  };
  return writeJson("lsp-ground-truth.json", groundTruth, options);
}

/**
 * Write the report-viewer data payload — the denormalized, reshaped subset of
 * the summary that the standalone report.html and the SPA report viewer both
 * consume. Written on every analyze so the server (and any external viewer) can
 * serve it directly, without re-denormalizing the summary per request.
 * Creates: <outputDir>/report-data.json
 */
export async function writeReportData(
  payload: unknown,
  options: OutputOptions,
): Promise<string> {
  return writeJson("report-data.json", payload, options);
}

/** Write an HTML report. Creates: <outputDir>/report.html */
export async function writeHtmlReport(html: string, options: OutputOptions): Promise<string> {
  const htmlPath = join(resolve(options.outputDir), "report.html");
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, html, "utf-8");
  return htmlPath;
}
