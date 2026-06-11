import { readFile } from "fs/promises";
import { resolve, join } from "path";
import type {
  FileAnalysis,
  ProjectAnalysis,
  Language,
} from "../types/analysis.js";
import type { DiscoveredFile } from "./file-discovery.js";
import {
  writeLspEnhancement,
  writeLspGroundTruth,
  type LspEnhancement,
  type OutputOptions,
} from "./output-writer.js";
import {
  enrichGraphFromSymbolLinks,
  enrichLinkGraphFromComponentGraph,
} from "./analyzer.js";
import { analyzeBlastRadius } from "./blast-radius.js";

export interface UpdateLspOptions {
  /** Path to the existing analysis output directory (contains project-summary.json). */
  analysisDir: string;
  /**
   * Optional explicit project root. When omitted, falls back to
   * the `projectRoot` field inside the summary file.
   */
  projectRoot?: string;
  pretty?: boolean;
  verbose?: boolean;
  lspTimeout?: number;
}

export interface UpdateLspResult {
  outputPath: string;
  serversUsed: string[];
  lspResolvedCount: number;
  referenceLinksCount: number;
  elapsedMs: number;
}

/**
 * Reads an existing analysis (from `analyze --no-lsp`), runs LSP enhancement
 * on top, and writes the result as a SEPARATE `lsp-enhancement.json` file.
 * The base `project-summary.json` is NOT modified — the HTML report merges
 * both files at render time.
 *
 * This lets the heavyweight Docker-based LSP step be run independently of
 * (and in parallel with) the fast text-based analysis step.
 */
export async function updateLsp(options: UpdateLspOptions): Promise<UpdateLspResult> {
  const startTime = Date.now();
  const dir = resolve(options.analysisDir);
  const verbose = !!options.verbose;

  // 1. Load the base summary and per-file analyses
  const summaryPath = join(dir, "project-summary.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf-8")) as ProjectAnalysis;

  const projectRoot = options.projectRoot ?? summary.projectRoot;
  if (!projectRoot) {
    throw new Error(`Cannot determine projectRoot — summary missing projectRoot field and none provided.`);
  }

  const perFileAnalyses: FileAnalysis[] = [];
  for (const relPath of summary.files ?? []) {
    const fileJsonPath = join(dir, `${relPath}.json`);
    try {
      const raw = await readFile(fileJsonPath, "utf-8");
      perFileAnalyses.push(JSON.parse(raw) as FileAnalysis);
    } catch (err) {
      if (verbose) {
        console.warn(`  Skipping ${relPath}: ${(err as Error).message}`);
      }
    }
  }

  // 2. Reconstruct DiscoveredFile[] from analyses
  const discoveredFiles: DiscoveredFile[] = perFileAnalyses.map((a) => ({
    absolutePath: join(projectRoot, a.filePath),
    relativePath: a.filePath,
    language: a.language as Language,
  }));

  // 3. Run LSP enhancement
  const { enhanceWithLsp } = await import("../lsp/lsp-enhancer.js");
  const existingLinks = summary.symbolLinks ?? [];
  const lspResult = await enhanceWithLsp({
    projectRoot,
    analyses: perFileAnalyses,
    existingLinks,
    files: discoveredFiles,
    verbose,
    timeout: options.lspTimeout,
  });

  // 4. Re-derive LSP-dependent fields
  const componentGraph: Record<string, string[]> = {};
  for (const [src, targets] of Object.entries(summary.componentGraph ?? {})) {
    componentGraph[src] = [...targets];
  }
  enrichGraphFromSymbolLinks(componentGraph, lspResult.enhancedLinks);

  const linkGraph = (summary.linkGraph ?? []).map((l) => ({ ...l }));
  enrichLinkGraphFromComponentGraph(linkGraph, componentGraph);

  const blastRadius = analyzeBlastRadius(
    componentGraph,
    lspResult.enhancedLinks,
    perFileAnalyses.length,
  );

  // 5. Write the enhancement delta as its own file
  const enhancement: LspEnhancement = {
    symbolLinks: lspResult.enhancedLinks,
    componentGraph,
    linkGraph,
    blastRadius,
    lspStats: {
      serversUsed: lspResult.serversUsed,
      lspResolvedCount: lspResult.lspResolvedCount,
      referenceLinksCount: lspResult.referenceLinksCount,
      enhancementTimeMs: lspResult.timeMs,
    },
    enhancedAt: new Date().toISOString(),
  };

  const outputOpts: OutputOptions = { outputDir: dir, pretty: options.pretty };
  const outputPath = await writeLspEnhancement(enhancement, outputOpts);

  // 6. Export the raw query/answer log alongside the merged enhancement, so
  // the text linker can be optimized against it (scripts/lsp-compare.mjs).
  if (lspResult.serversUsed.length > 0) {
    await writeLspGroundTruth(projectRoot, lspResult, outputOpts);
  }

  return {
    outputPath,
    serversUsed: lspResult.serversUsed,
    lspResolvedCount: lspResult.lspResolvedCount,
    referenceLinksCount: lspResult.referenceLinksCount,
    elapsedMs: Date.now() - startTime,
  };
}
