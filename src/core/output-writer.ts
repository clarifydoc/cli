import { writeFile, mkdir } from "fs/promises";
import { resolve, dirname, join } from "path";
import type {
  FileAnalysis,
  ProjectAnalysis,
  LspStats,
  SymbolLink,
  BlastRadiusInfo,
  LinkInfo,
  LspDefinitionRecord,
  LspReferenceRecord,
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
}

/**
 * Raw LSP query/answer log — written as a SEPARATE file from the merged links
 * so the text-based linker can be optimized against it: re-run text analysis,
 * then compare its links to these records (scripts/lsp-compare.mjs). Unlike
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
  generatedAt: string;
}

export interface OutputOptions {
  outputDir: string;
  pretty?: boolean;
}

/**
 * Write a single file analysis result as JSON.
 * Creates: <outputDir>/<relativePath>.json
 */
export async function writeFileAnalysis(
  analysis: FileAnalysis,
  options: OutputOptions,
): Promise<string> {
  const outPath = resolve(options.outputDir, `${analysis.filePath}.json`);
  await mkdir(dirname(outPath), { recursive: true });

  // Run schema validation once per file. Warnings are collected, not thrown —
  // an extractor producing malformed output should still produce visible output
  // with the issue flagged inline.
  const warnings = validateFileAnalysis(analysis);
  if (warnings.length > 0) {
    analysis.extractorWarnings = warnings;
  }

  const json = options.pretty
    ? JSON.stringify(analysis, null, 2)
    : JSON.stringify(analysis);

  await writeFile(outPath, json, "utf-8");
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
