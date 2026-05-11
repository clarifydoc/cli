import { writeFile, mkdir } from "fs/promises";
import { resolve, dirname, join } from "path";
import type {
  FileAnalysis,
  ProjectAnalysis,
  LspStats,
  SymbolLink,
  BlastRadiusInfo,
  LinkInfo,
} from "../types/analysis.js";
import { validateFileAnalysis } from "./fileanalysis-validator.js";

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

/**
 * Write the project-level summary.
 * Creates: <outputDir>/project-summary.json
 */
export async function writeProjectSummary(
  summary: ProjectAnalysis,
  options: OutputOptions,
): Promise<string> {
  const outPath = join(resolve(options.outputDir), "project-summary.json");
  await mkdir(dirname(outPath), { recursive: true });

  const json = options.pretty
    ? JSON.stringify(summary, null, 2)
    : JSON.stringify(summary);

  await writeFile(outPath, json, "utf-8");
  return outPath;
}

/**
 * Write the LSP enhancement delta.
 * Creates: <outputDir>/lsp-enhancement.json
 */
export async function writeLspEnhancement(
  enhancement: LspEnhancement,
  options: OutputOptions,
): Promise<string> {
  const outPath = join(resolve(options.outputDir), "lsp-enhancement.json");
  await mkdir(dirname(outPath), { recursive: true });

  const json = options.pretty
    ? JSON.stringify(enhancement, null, 2)
    : JSON.stringify(enhancement);

  await writeFile(outPath, json, "utf-8");
  return outPath;
}

/** Write an HTML report. Creates: <outputDir>/report.html */
export async function writeHtmlReport(html: string, options: OutputOptions): Promise<string> {
  const htmlPath = join(resolve(options.outputDir), "report.html");
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, html, "utf-8");
  return htmlPath;
}
