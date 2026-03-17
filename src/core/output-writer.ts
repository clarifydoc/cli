import { writeFile, mkdir } from "fs/promises";
import { resolve, dirname, join } from "path";
import type { FileAnalysis, ProjectAnalysis } from "../types/analysis.js";

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
