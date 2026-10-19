import { readFile, writeFile } from "fs/promises";
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
import { denormalizeProject, denormalizeFileAnalysis } from "./element-registry.js";

/** Inputs to `updateLsp`: the analysis to enhance and the LSP run settings. */
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
  /**
   * Write the definition questions layer 2 would ask to this file and stop —
   * no server starts. An editor answers them with its own language servers.
   */
  emitQueries?: string;
  /** Answer from this file (`DefinitionAnswerFile`) instead of starting the Docker servers. */
  answers?: string;
}

/**
 * What an LSP update produced: the enhancement file written, the language
 * servers that answered, and how many links each query kind resolved.
 */
export interface UpdateLspResult {
  outputPath: string;
  /** Where the answers came from: `docker`, `editor`, … (`queries` for `emitQueries`). */
  source: string;
  /** Questions the source declined because its answers disagreed. */
  abstained?: number;
  /** Questions written (`emitQueries`). */
  queryCount?: number;
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
  // denormalizeProject no-ops on old-format artifacts; reconstructs symbolLinks/etc. on new ones.
  const summary = denormalizeProject(JSON.parse(await readFile(summaryPath, "utf-8")));

  const projectRoot = options.projectRoot ?? summary.projectRoot;
  if (!projectRoot) {
    throw new Error(`Cannot determine projectRoot — summary missing projectRoot field and none provided.`);
  }

  const perFileAnalyses: FileAnalysis[] = [];
  for (const relPath of summary.files ?? []) {
    const fileJsonPath = join(dir, `${relPath}.json`);
    try {
      const raw = await readFile(fileJsonPath, "utf-8");
      // denormalizeFileAnalysis no-ops today (Phase 0 identity); future-proofs Phase 4.
      perFileAnalyses.push(denormalizeFileAnalysis(JSON.parse(raw)));
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
  const { enhanceWithLsp, planDefinitionQueries } = await import("../lsp/lsp-enhancer.js");
  const existingLinks = summary.symbolLinks ?? [];
  if (options.emitQueries) {
    const queries = await planDefinitionQueries(projectRoot, perFileAnalyses, existingLinks);
    const outputPath = resolve(options.emitQueries);
    await writeFile(outputPath, JSON.stringify({ projectRoot, queries }, null, options.pretty ? 2 : undefined));
    return { outputPath, source: "queries", serversUsed: [], lspResolvedCount: 0, referenceLinksCount: 0, elapsedMs: Date.now() - startTime, queryCount: queries.length };
  }
  let answers: (import("../lsp/lsp-enhancer.js").DefinitionSource & { abstained(): number }) | undefined;
  if (options.answers) {
    const { answersDefinitionSource, readDefinitionAnswers } = await import("../lsp/answers-source.js");
    // The lines where the analysis declares something: what a disagreeing answer is narrowed to.
    const declared = new Set<string>();
    for (const fa of perFileAnalyses) {
      for (const fn of fa.functions) declared.add(`${fa.filePath}:${fn.line}`);
      for (const cls of fa.classes) {
        declared.add(`${fa.filePath}:${cls.line}`);
        for (const m of cls.methods) declared.add(`${fa.filePath}:${m.line}`);
      }
    }
    answers = answersDefinitionSource(await readDefinitionAnswers(resolve(options.answers)), (f, line) => declared.has(`${f}:${line}`));
  }
  const lspResult = await enhanceWithLsp({
    projectRoot,
    analyses: perFileAnalyses,
    existingLinks,
    files: discoveredFiles,
    verbose,
    timeout: options.lspTimeout,
    ...(answers ? { source: answers } : {}),
  });

  // 4. Re-derive LSP-dependent fields
  const componentGraph: Record<string, string[]> = {};
  for (const [src, targets] of Object.entries(summary.componentGraph ?? {})) {
    componentGraph[src] = [...targets];
  }
  enrichGraphFromSymbolLinks(componentGraph, lspResult.enhancedLinks);

  const linkGraph = (summary.linkGraph ?? []).map((l) => ({ ...l }));
  enrichLinkGraphFromComponentGraph(linkGraph, componentGraph);

  const lineCounts = new Map<string, number>();
  for (const a of perFileAnalyses) if (a.lineCount !== undefined) lineCounts.set(a.filePath, a.lineCount);
  const blastRadius = analyzeBlastRadius(
    componentGraph,
    lspResult.enhancedLinks,
    perFileAnalyses.length,
    { lineCounts },
  );

  // 5. Write the enhancement delta as its own file
  const enhancement: LspEnhancement = {
    symbolLinks: lspResult.enhancedLinks,
    componentGraph,
    linkGraph,
    blastRadius,
    lspStats: {
      source: lspResult.source,
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
  // the text linker can be optimized against it. Only the Docker servers'
  // log: another source's answers are budgeted and editor-dependent, and must
  // not overwrite a complete capture.
  if (lspResult.serversUsed.length > 0 && lspResult.source === "docker") {
    await writeLspGroundTruth(projectRoot, lspResult, outputOpts);
  }

  return {
    outputPath,
    source: lspResult.source,
    ...(answers ? { abstained: answers.abstained() } : {}),
    serversUsed: lspResult.serversUsed,
    lspResolvedCount: lspResult.lspResolvedCount,
    referenceLinksCount: lspResult.referenceLinksCount,
    elapsedMs: Date.now() - startTime,
  };
}
