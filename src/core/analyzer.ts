import { readFile } from "fs/promises";
import { resolve as pathResolve } from "path";
import { discoverFiles, type DiscoveryOptions, type DiscoveredFile } from "./file-discovery.js";
import {
  EXTRACTOR_VERSION,
  loadManifest,
  saveManifest,
  classifyFile as classifyFileForCache,
  normalizeManifestKey,
  type Manifest,
} from "./manifest.js";
import {
  gatherProjectInfo,
  detectFrameworks,
} from "./framework-detector.js";
import { detectSubProjects, assignProjectId } from "./project-detector.js";
import {
  writeProjectSummary,
  type OutputOptions,
} from "./output-writer.js";
import { analyzeFile, type FileTask, type FileResult } from "./file-analyzer.js";
import { AnalysisWorkerPool } from "./worker-pool.js";
import { loadTsconfigAliases } from "../extractors/shared/tsconfig-aliases.js";
import { buildLinkGraph } from "../extractors/shared/link-scoring.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import { aggregateComplexity } from "./complexity-analyzer.js";
import { detectPatterns } from "./pattern-detector.js";
import { detectDuplicates } from "./duplication-detector.js";
import { classifyFileLayers, detectLayerViolations } from "./layer-analyzer.js";
import { analyzeBlastRadius } from "./blast-radius.js";
import { computeHealthScore } from "./health-scorer.js";
import { generateSuggestions } from "./suggestions-engine.js";
import { detectCommunities } from "./community-detector.js";
import { findGodNodes, findSurprisingConnections, suggestQuestions } from "./topology-analyzer.js";
import { dedupSymbolLinks } from "./symbol-dedup.js";
import { aggregateTypeBlast, buildClassGraph } from "./data-model-blast.js";
import { buildDataAccessGraph } from "./data-access-graph.js";
import {
  type FileAnalysis,
  type ProjectAnalysis,
  type ScreenInfo,
  type ScreenComponentInfo,
  type ScreenComponentCategory,
  type ComplexityInfo,
  type SecurityIssue,
} from "../types/analysis.js";

export interface AnalyzeOptions {
  projectRoot: string;
  outputDir: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  pretty?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  lsp?: boolean;
  lspTimeout?: number;
  /**
   * When true, files whose mtime + SHA-256 match the on-disk manifest are not
   * re-parsed — their cached FileAnalysis JSON is loaded from disk and reused.
   * Post-analysis (linkGraph, symbolLinks, etc.) always runs on the full set.
   */
  incremental?: boolean;
}

export interface AnalyzeResult {
  fileCount: number;
  files: string[];
  outputDir: string;
  interactiveElementCount: number;
  routeCount: number;
  linkCount: number;
  screenCount: number;
  symbolLinkCount: number;
  healthGrade?: string;
  patternCount?: number;
  securityIssueCount?: number;
  suggestionCount?: number;
}

// ─── Concurrency pool ────────────────────────────────────────────────────

/**
 * Run async tasks with a bounded concurrency limit.
 * Returns results in original item order.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onComplete?: (index: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]!, i);
      onComplete?.(i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Read a previously-written FileAnalysis JSON from disk and rebuild a FileResult
 * matching what `analyzeFile` would produce. Returns null when the cache file is
 * missing/corrupted so the caller can fall back to a fresh parse.
 *
 * The raw source is re-read only for frontend route files — they're a small
 * subset and the source is needed downstream for screen building.
 */
async function loadCachedFileResult(
  file: DiscoveredFile,
  outputDir: string,
): Promise<FileResult | null> {
  const cachedPath = pathResolve(outputDir, `${file.relativePath}.json`);
  let analysis: FileAnalysis;
  try {
    const raw = await readFile(cachedPath, "utf-8");
    analysis = JSON.parse(raw) as FileAnalysis;
  } catch {
    return null;
  }
  if (!analysis || !analysis.filePath) return null;

  // Pull per-file complexity/security out of the cached analysis so the
  // project-level aggregators see the same data they would from a fresh parse.
  const complexities = analysis.complexities ?? [];
  const securityIssues = analysis.securityIssues ?? [];

  const hasFrontendRoute = (analysis.routes ?? []).some((r) => r.kind === "frontend");
  let rawSource: string | null = null;
  if (hasFrontendRoute) {
    try {
      rawSource = await readFile(file.absolutePath, "utf-8");
    } catch {
      rawSource = null;
    }
  }

  return { analysis, rawSource, complexities, securityIssues };
}

// ─── Progress reporter ──────────────────────────────────────────────────

/**
 * Reports progress to the CLI. In non-verbose mode, shows a single updating
 * status line. In verbose mode, writes each step on its own line.
 */
class ProgressReporter {
  private verbose: boolean;
  private active = false;
  private lastLine = "";

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  /** Show a top-level pipeline step (e.g. "Discovering files"). */
  step(message: string): void {
    if (this.verbose) {
      console.log(message);
    } else {
      this.writeStatus(message);
    }
  }

  /** Update the current status line (non-verbose only). */
  status(message: string): void {
    if (!this.verbose) this.writeStatus(message);
  }

  /** Log a detail line (only shown in verbose mode). */
  detail(message: string): void {
    if (this.verbose) console.log(message);
  }

  /** Print a final line that stays visible. */
  finalize(message: string): void {
    this.clear();
    console.log(message);
  }

  /** Clear the in-place status line (non-verbose only). */
  clear(): void {
    if (!this.verbose && this.active) {
      process.stdout.write("\r" + " ".repeat(this.lastLine.length) + "\r");
      this.active = false;
      this.lastLine = "";
    }
  }

  private writeStatus(message: string): void {
    const line = message.length > 79 ? message.slice(0, 76) + "..." : message;
    const padding = Math.max(0, this.lastLine.length - line.length);
    process.stdout.write("\r" + line + " ".repeat(padding));
    this.active = true;
    this.lastLine = line;
  }
}

// ─── Main pipeline ───────────────────────────────────────────────────────

/**
 * Main analysis pipeline:
 * 1. Discover files
 * 2. Detect frameworks
 * 3. Parse each file and run extractors (parallel)
 * 4. Post-analysis: build symbol links
 * 5. Write project summary
 */
export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { projectRoot, outputDir, verbose, dryRun } = options;
  const progress = new ProgressReporter(!!verbose);

  // Step 1: Discover files
  progress.step("Discovering files...");
  const discoveryOpts: DiscoveryOptions = {
    include: options.include,
    exclude: options.exclude,
    maxFiles: options.maxFiles,
  };
  const discovery = await discoverFiles(projectRoot, discoveryOpts);
  const files = discovery.files;
  const skippedSensitive = discovery.skippedSensitive;

  progress.detail(`Found ${files.length} source files`);
  if (skippedSensitive.length > 0) {
    progress.detail(`Skipped ${skippedSensitive.length} sensitive file(s)`);
  }

  if (dryRun) {
    return {
      fileCount: files.length,
      files: files.map((f) => f.relativePath),
      outputDir,
      interactiveElementCount: 0,
      routeCount: 0,
      linkCount: 0,
      screenCount: 0,
      symbolLinkCount: 0,
    };
  }

  // Step 2: Detect frameworks
  progress.step("Detecting frameworks...");
  const projectInfo = await gatherProjectInfo(projectRoot);
  const frameworks = detectFrameworks(projectInfo);
  const frameworkIds = frameworks.map((f) => f.id);

  progress.detail(
    frameworks.length > 0
      ? `Detected: ${frameworks.map((f) => f.name).join(", ")}`
      : "No frameworks detected",
  );

  // Step 2b: Detect sub-projects (monorepo packages, multi-language repos)
  progress.step("Detecting sub-projects...");
  const subProjects = await detectSubProjects(projectRoot);
  const fileProjects: Record<string, string> = {};
  for (const f of files) {
    fileProjects[f.relativePath] = assignProjectId(f.relativePath, subProjects);
  }
  const realProjectCount = subProjects.filter((p) => p.id !== "root").length;
  progress.detail(
    realProjectCount > 0
      ? `Detected ${realProjectCount} sub-project${realProjectCount === 1 ? "" : "s"}`
      : "No sub-projects detected (single project)",
  );

  // Step 3: Analyze each file (parallel with concurrency limit).
  // When `incremental` is on, classify each file against the manifest first;
  // unchanged files skip parsing and reuse their on-disk FileAnalysis JSON.
  progress.step(`Analyzing ${files.length} files...`);
  const outputOpts: OutputOptions = { outputDir, pretty: options.pretty };
  const tsconfigAliases = loadTsconfigAliases(projectRoot);
  if (tsconfigAliases.size > 0 && verbose) {
    progress.detail(`  tsconfig aliases: ${[...tsconfigAliases.keys()].join(", ")}`);
  }
  let completedCount = 0;

  const prevManifest = options.incremental ? await loadManifest(outputDir) : null;
  const newManifestEntries: Record<string, { mtime: number; sha256: string }> = {};
  let unchangedCount = 0;
  let reparsedCount = 0;

  // Per-file analysis is CPU-bound (tree-sitter + extractors), so spread it
  // across worker threads when the project is big enough to amortize worker
  // startup. Falls back to in-process analysis when workers are unavailable
  // (e.g. running from source, REVERSEDOC_WORKERS=0, or tiny projects).
  const poolSize = AnalysisWorkerPool.defaultSize(files.length);
  const pool = poolSize > 0 ? AnalysisWorkerPool.create(poolSize, analyzeFile) : null;
  const runTask = (task: FileTask): Promise<FileResult | null> =>
    pool ? pool.run(task) : analyzeFile(task);
  // With a pool, keep a couple of extra slots so the main thread can overlap
  // manifest classification / cache reads while every worker stays busy.
  const fileConcurrency = pool ? poolSize + 2 : 8;

  let results: (FileResult | null)[];
  try {
    results = await runWithConcurrency(
      files,
      fileConcurrency,
      async (file, _i) => {
        progress.detail(`  Analyzing: ${file.relativePath}`);
        progress.status(`Analyzing [${completedCount}/${files.length}] ${file.relativePath}`);
        const projectId = fileProjects[file.relativePath] ?? "root";
        const manifestKey = normalizeManifestKey(file.relativePath);

        if (options.incremental && prevManifest) {
          const prev = prevManifest.entries[manifestKey];
          const classification = await classifyFileForCache(file.absolutePath, prev);
          newManifestEntries[manifestKey] = { mtime: classification.mtime, sha256: classification.sha256 };
          if (classification.state === "unchanged") {
            const cached = await loadCachedFileResult(file, outputDir);
            if (cached) {
              unchangedCount++;
              return cached;
            }
            // Cache file missing — fall through to fresh parse.
          }
        }

        const result = await runTask({
          file, frameworkIds, projectId, outputOpts, verbose: !!verbose,
          projectRoot, tsconfigAliases,
        });
        if (options.incremental && !prevManifest) {
          // First-time incremental run: compute hash for manifest seed.
          const classification = await classifyFileForCache(file.absolutePath, undefined);
          newManifestEntries[manifestKey] = { mtime: classification.mtime, sha256: classification.sha256 };
        } else if (options.incremental && prevManifest && !newManifestEntries[manifestKey]) {
          const classification = await classifyFileForCache(file.absolutePath, undefined);
          newManifestEntries[manifestKey] = { mtime: classification.mtime, sha256: classification.sha256 };
        }
        if (result) reparsedCount++;
        return result;
      },
      () => {
        completedCount++;
      },
    );
  } finally {
    await pool?.destroy();
  }

  if (options.incremental) {
    progress.detail(`  Incremental: ${unchangedCount} unchanged, ${reparsedCount} reparsed`);
  }

  // Collect successful results
  const allAnalyses: FileAnalysis[] = [];
  const rawSources = new Map<string, string>();
  const perFileComplexity: { filePath: string; complexities: ComplexityInfo[] }[] = [];
  const allSecurityIssues: SecurityIssue[] = [];

  for (const result of results) {
    if (!result) continue;
    allAnalyses.push(result.analysis);
    if (result.rawSource) {
      rawSources.set(result.analysis.filePath, result.rawSource);
    }
    // Prefer per-file fields stored on the analysis (works for both fresh and
    // cached paths); fall back to the FileResult fields for the fresh path.
    const complexities = result.analysis.complexities ?? result.complexities;
    if (complexities.length > 0) {
      perFileComplexity.push({ filePath: result.analysis.filePath, complexities });
    }
    const securityIssues = result.analysis.securityIssues ?? result.securityIssues;
    if (securityIssues.length > 0) {
      allSecurityIssues.push(...securityIssues);
    }
  }

  // Step 4: Post-analysis
  progress.step("Building dependency graph...");
  const componentGraph = buildComponentGraph(allAnalyses);
  progress.status("Building link graph...");
  const linkGraph = buildLinkGraph(allAnalyses);
  progress.status("Resolving cross-file symbols...");
  let symbolLinks = dedupSymbolLinks(buildSymbolLinks(allAnalyses));

  // Step 4b: LSP enhancement (optional)
  let lspStats: import("../types/analysis.js").LspStats | undefined;
  if (options.lsp !== false) {
    try {
      const { enhanceWithLsp } = await import("../lsp/lsp-enhancer.js");
      progress.step("Running LSP enhancement...");
      const lspResult = await enhanceWithLsp({
        projectRoot,
        analyses: allAnalyses,
        existingLinks: symbolLinks,
        files,
        verbose: !!verbose,
        timeout: options.lspTimeout,
      });
      symbolLinks = dedupSymbolLinks(lspResult.enhancedLinks);
      lspStats = {
        serversUsed: lspResult.serversUsed,
        lspResolvedCount: lspResult.lspResolvedCount,
        referenceLinksCount: lspResult.referenceLinksCount,
        enhancementTimeMs: lspResult.timeMs,
      };
      if (lspResult.serversUsed.length > 0) {
        progress.detail(`  LSP enhancement: +${lspResult.lspResolvedCount} definitions, +${lspResult.referenceLinksCount} references (${lspResult.timeMs}ms)`);
      }
    } catch (err) {
      progress.detail(`LSP enhancement skipped: ${(err as Error).message}`);
    }
  }
  // Enrich component graph with edges from symbol links
  // This catches cross-file dependencies that import resolution missed
  // (e.g. Java package imports, Python absolute imports, C# usings)
  enrichGraphFromSymbolLinks(componentGraph, symbolLinks);

  // Enrich link graph from component graph edges that buildLinkGraph missed
  // (e.g. Go package imports resolved via directory matching)
  enrichLinkGraphFromComponentGraph(linkGraph, componentGraph);

  const allRoutes = allAnalyses.flatMap((a) =>
    a.routes.map((r) => ({ ...r, filePath: a.filePath })),
  );
  const allInteractiveElements = allAnalyses.flatMap((a) =>
    a.interactiveElements.map((el) => ({ ...el, filePath: a.filePath })),
  );
  const allEvents = allAnalyses.flatMap((a) =>
    a.events.map((ev) => ({ ...ev, filePath: a.filePath })),
  );
  // Aggregate outbound API calls (kind=api-call data sources)
  const allApiCalls = allAnalyses.flatMap((a) =>
    a.dataSources
      .filter((ds) => ds.kind === "api-call")
      .map((ds) => ({ ...ds, filePath: a.filePath })),
  );
  // Build screens: DFM screens + web screens from routes
  const dfmScreens = allAnalyses.flatMap((a) => a.screens ?? []);
  const webScreens = buildScreensFromRoutes(allAnalyses, rawSources);
  const allScreens = [...dfmScreens, ...webScreens];

  // Step 4c: Advanced analysis
  progress.step("Analyzing complexity and patterns...");
  const complexity = aggregateComplexity(perFileComplexity);
  const patterns = detectPatterns(allAnalyses, frameworks);
  progress.status("Detecting duplicates and layer violations...");
  const duplicates = detectDuplicates(allAnalyses);
  const fileLayerMap = classifyFileLayers(allAnalyses.map((a) => a.filePath));
  const layerViolations = detectLayerViolations(allAnalyses, componentGraph, fileLayerMap);
  progress.status("Detecting communities...");
  const fileList = allAnalyses.map((a) => a.filePath);
  const { communities, cohesion } = detectCommunities(linkGraph, fileList);

  progress.status("Computing topology insights...");
  const godNodes = findGodNodes(componentGraph, fileList, 10);
  const surprisingConnections = findSurprisingConnections(linkGraph, communities, componentGraph, 5);
  const suggestedQuestions = suggestQuestions(linkGraph, communities, cohesion, componentGraph, fileList, 7);

  progress.status("Computing blast radius and health score...");
  const blastRadius = analyzeBlastRadius(componentGraph, symbolLinks, allAnalyses.length);

  // Per-class type-usage blast — attach to the BlastRadiusInfo for the file
  // that defines each class. Empty entries are dropped to keep the JSON lean.
  const typeBlastMap = aggregateTypeBlast(allAnalyses);
  for (const info of blastRadius) {
    const summaries = typeBlastMap.get(info.filePath);
    if (summaries && summaries.length > 0) {
      info.typeUsages = summaries;
    }
  }

  // Class-level dependency graph for the Architecture tab's Data Models view.
  const classGraph = buildClassGraph(allAnalyses);

  // File→datastore graph for the Architecture tab's Data Access view.
  const dataAccessGraph = buildDataAccessGraph(allAnalyses);

  const healthScore = computeHealthScore({
    analyses: allAnalyses,
    componentGraph,
    patterns,
    securityIssues: allSecurityIssues,
    duplicates,
    complexity,
    layerViolations,
  });
  progress.status("Generating suggestions...");
  const suggestions = generateSuggestions({
    analyses: allAnalyses,
    healthScore,
    patterns,
    securityIssues: allSecurityIssues,
    duplicates,
    complexity,
    layerViolations,
    blastRadius,
    componentGraph,
  });

  progress.detail(`  Health: ${healthScore.grade} (${healthScore.score}/100)`);
  progress.detail(`  Patterns: ${patterns.length}, Security: ${allSecurityIssues.length}, Duplicates: ${duplicates.length}`);
  progress.detail(`  Suggestions: ${suggestions.length}`);

  // Aggregate confidence counts across symbolLinks — quick quality snapshot for the report.
  const confidenceCounts = { extracted: 0, inferred: 0, ambiguous: 0 };
  for (const link of symbolLinks) {
    if (link.confidence === "EXTRACTED") confidenceCounts.extracted++;
    else if (link.confidence === "INFERRED") confidenceCounts.inferred++;
    else if (link.confidence === "AMBIGUOUS") confidenceCounts.ambiguous++;
  }

  // Step 5: Write project summary
  const summary: ProjectAnalysis = {
    projectRoot,
    detectedFrameworks: frameworks,
    subProjects,
    fileProjects,
    files: allAnalyses.map((a) => a.filePath),
    componentGraph,
    linkGraph,
    interactiveElements: allInteractiveElements,
    events: allEvents,
    routeMap: allRoutes,
    apiCalls: allApiCalls,
    screens: allScreens,
    symbolLinks,
    lspStats,
    analyzedAt: new Date().toISOString(),
    complexity,
    patterns,
    securityIssues: allSecurityIssues,
    duplicates,
    layerViolations,
    blastRadius,
    healthScore,
    suggestions,
    fileLayerMap,
    confidenceCounts,
    skippedSensitive: skippedSensitive.length > 0 ? skippedSensitive : undefined,
    communities: Object.keys(communities).length > 0 ? communities : undefined,
    cohesion: Object.keys(cohesion).length > 0 ? cohesion : undefined,
    godNodes: godNodes.length > 0 ? godNodes : undefined,
    surprisingConnections: surprisingConnections.length > 0 ? surprisingConnections : undefined,
    suggestedQuestions: suggestedQuestions.length > 0 ? suggestedQuestions : undefined,
    classGraph: classGraph.nodes.length > 0 ? classGraph : undefined,
    dataAccessGraph: dataAccessGraph.nodes.length > 0 ? dataAccessGraph : undefined,
  };

  progress.step("Writing project summary...");
  await writeProjectSummary(summary, outputOpts);

  // Save the manifest only after the rest of the pipeline succeeds so a crash
  // mid-run leaves the previous manifest intact.
  if (options.incremental) {
    const manifest: Manifest = {
      version: 1,
      extractorVersion: EXTRACTOR_VERSION,
      entries: newManifestEntries,
    };
    await saveManifest(outputDir, manifest);
  }

  progress.clear();

  return {
    fileCount: allAnalyses.length,
    files: allAnalyses.map((a) => a.filePath),
    outputDir,
    interactiveElementCount: allInteractiveElements.length,
    routeCount: allRoutes.length,
    linkCount: linkGraph.length,
    screenCount: allScreens.length,
    symbolLinkCount: symbolLinks.length,
    healthGrade: healthScore.grade,
    patternCount: patterns.length,
    securityIssueCount: allSecurityIssues.length,
    suggestionCount: suggestions.length,
  };
}

// ─── Build screens from frontend routes ──────────────────────────────────

const WEB_ELEMENT_CATEGORY: Record<string, ScreenComponentCategory> = {
  button: "action",
  input: "input",
  form: "container",
  link: "navigation",
  select: "input",
  textarea: "input",
  custom: "custom",
};

/** Extract page title from JSX/Vue source via <h1> tag */
function extractPageTitle(source: string): string | null {
  // JSX: <h1>Login</h1> or <h1>Users</h1>
  const jsxMatch = source.match(/<h1[^>]*>([^<{]+)<\/h1>/);
  if (jsxMatch) return jsxMatch[1].trim();
  // Vue: <h1>{{ title }}</h1> — shows the binding name
  const vueMatch = source.match(/<h1[^>]*>\{\{\s*(\w+)\s*\}\}<\/h1>/);
  if (vueMatch) return `{{ ${vueMatch[1]} }}`;
  return null;
}

/** Extract navigation targets from source (navigate(), router.push(), Link, href) */
function extractNavigationTargets(source: string): string[] {
  const targets = new Set<string>();
  const patterns = [
    /navigate\(\s*['"`]([^'"`\s]+)['"`]/g,
    /router\.push\(\s*['"`]([^'"`\s]+)['"`]/g,
    /<Link\s+[^>]*to\s*=\s*['"`]([^'"`]+)['"`]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const path = m[1];
      if (path && path.startsWith("/")) targets.add(path);
    }
  }
  return [...targets];
}

/**
 * Build ScreenInfo[] from files that define frontend routes.
 * Assembles subComponents + interactiveElements into a screen tree.
 */
function buildScreensFromRoutes(
  allAnalyses: FileAnalysis[],
  rawSources: Map<string, string>,
): ScreenInfo[] {
  const screens: ScreenInfo[] = [];

  // Find files with frontend routes
  for (const analysis of allAnalyses) {
    const frontendRoutes = analysis.routes.filter((r) => r.kind === "frontend");
    if (frontendRoutes.length === 0) continue;

    const routePath = frontendRoutes[0].path;
    const rawSource = rawSources.get(analysis.filePath) ?? "";

    // Determine screen name: prefer named function/class, then filename
    const namedExport = analysis.exports.find((e) => e.name !== "default" && (e.kind === "function" || e.kind === "class"));
    const defaultFn = analysis.functions.find((f) => f.isExported && f.name !== "default");
    const fileBaseName = analysis.filePath.replace(/^.*[\\/]/, "").replace(/\.\w+$/, "");
    const screenName = namedExport?.name ?? defaultFn?.name ?? fileBaseName;

    // Determine form type
    const isVue = analysis.filePath.endsWith(".vue");
    const formType = isVue ? "VuePage" : "ReactPage";

    // Extract caption from <h1>
    const caption = extractPageTitle(rawSource);

    // Build component list
    const components: ScreenComponentInfo[] = [];

    // Track which interactiveElements belong to subComponents
    const usedInteractiveIndices = new Set<number>();

    // Add sub-components (UserTable, UserForm, StatsPanel, etc.)
    for (const sub of analysis.subComponents) {
      // Find interactive elements that match this sub-component
      const compEvents: string[] = [];
      analysis.interactiveElements.forEach((el, idx) => {
        if (el.element === "custom") {
          // Check if the interactive element's props overlap with this subComponent
          // Custom elements at similar line range are likely the same component
          const propMatch = sub.props.some((p) =>
            el.event.toLowerCase().includes(p.toLowerCase()) ||
            p.toLowerCase().includes(el.event.replace(/^@|^on/, "").toLowerCase()),
          );
          if (propMatch || (el.handler && el.handler.toLowerCase().includes(sub.name.toLowerCase()))) {
            compEvents.push(el.event + (el.handler ? ` → ${el.handler}` : ""));
            usedInteractiveIndices.add(idx);
          }
        }
      });

      components.push({
        name: sub.name,
        componentType: sub.importSource ?? sub.name,
        category: "custom",
        caption: null,
        position: null,
        align: null,
        visible: true,
        children: [],
        events: compEvents,
        dataBindings: sub.props.filter((p) => !p.startsWith("on") && !p.startsWith("@")),
        line: sub.line,
      });
    }

    // Add HTML interactive elements (buttons, inputs, forms, links)
    const elementCounts: Record<string, number> = {};
    analysis.interactiveElements.forEach((el, idx) => {
      if (usedInteractiveIndices.has(idx)) return;

      const count = (elementCounts[el.element] = (elementCounts[el.element] ?? 0) + 1);
      const name = el.handler ?? `${el.element}-${count}`;

      components.push({
        name,
        componentType: el.element,
        category: WEB_ELEMENT_CATEGORY[el.element] ?? "display",
        caption: null,
        position: null,
        align: null,
        visible: true,
        children: [],
        events: [el.event + (el.handler ? ` → ${el.handler}` : "")],
        dataBindings: [],
        line: el.line,
      });
    });

    // Extract navigation targets
    const navigatesTo = extractNavigationTargets(rawSource);

    screens.push({
      name: screenName,
      formType,
      caption,
      dimensions: null,
      components,
      filePath: analysis.filePath,
      routePath,
      navigatesTo,
    });
  }

  return screens;
}

/** Build a graph of file -> files it imports */
function buildComponentGraph(
  analyses: FileAnalysis[],
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};

  // Build a map of export names to file paths for resolution
  const exportToFile = new Map<string, string>();
  for (const a of analyses) {
    for (const exp of a.exports) {
      exportToFile.set(exp.name, a.filePath);
    }
  }

  // Build a map of file base names (without extension) to file paths
  const baseNameToFile = new Map<string, string>();
  // Build a map of stripped paths to file paths for relative import resolution (O(1) lookup)
  const strippedPathToFile = new Map<string, string>();
  // Build a map of directory names → files in that directory (for Go/Rust package imports)
  const dirToFiles = new Map<string, string[]>();
  for (const a of analyses) {
    const baseName = a.filePath.replace(/^.*[\\/]/, "").replace(/\.\w+$/, "");
    baseNameToFile.set(baseName, a.filePath);
    const stripped = a.filePath
      .replace(/\.(ts|tsx|js|jsx|mjs|cjs|vue|py|java|kt|cs|pas|go|rs|rb|php|swift|lua|scala|pl|pm|vb|bas|cls|frm|sql|ddl|dml|psql|mysql|tsql|plsql|c|h|cpp|cc|cxx|hpp|hxx|hh)$/, "")
      .replace(/\/index$/, "");
    strippedPathToFile.set(stripped, a.filePath);

    // Map directory name → files
    const dir = a.filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
    const dirName = dir.split("/").pop() ?? dir;
    if (!dirToFiles.has(dirName)) dirToFiles.set(dirName, []);
    dirToFiles.get(dirName)!.push(a.filePath);
  }

  // The scans below depend only on the candidate string, and the same
  // candidate recurs across files (e.g. many files import "./types"), so
  // memoize per candidate. `undefined` (no match) is cached too.
  const importScanCache = new Map<string, string | undefined>();
  const scanForImport = (candidate: string): string | undefined => {
    if (importScanCache.has(candidate)) return importScanCache.get(candidate);
    let match: string | undefined;
    for (const [stripped, filePath] of strippedPathToFile) {
      if (stripped.endsWith(candidate) || candidate.endsWith(stripped)) {
        match = filePath;
        break;
      }
    }
    importScanCache.set(candidate, match);
    return match;
  };
  const subComponentScanCache = new Map<string, string | undefined>();
  const scanForSubComponent = (candidate: string): string | undefined => {
    if (subComponentScanCache.has(candidate)) return subComponentScanCache.get(candidate);
    let match: string | undefined;
    for (const [stripped, filePath] of strippedPathToFile) {
      if (stripped.endsWith(candidate)) {
        match = filePath;
        break;
      }
    }
    subComponentScanCache.set(candidate, match);
    return match;
  };

  for (const a of analyses) {
    const refSet = new Set<string>();

    for (const imp of a.imports) {
      // 1. Resolve relative imports (JS/TS/Vue) via pre-built path map
      if (imp.source.startsWith(".")) {
        const candidate = imp.source.replace(/^\.\//, "");
        const match = scanForImport(candidate);
        if (match && match !== a.filePath) refSet.add(match);
        continue;
      }

      // 2. Resolve non-relative imports via specifier names → exported names
      // Works for Java (import com.example.api.service.UserService → specifier "UserService")
      // Works for Python (from app.services import UserService → specifier "UserService")
      // Works for C# (using MyApp.Services → specifier matching)
      for (const spec of imp.specifiers) {
        if (!spec) continue;
        const target = exportToFile.get(spec);
        if (target && target !== a.filePath) {
          refSet.add(target);
        }
      }

      // 3. Resolve by matching the last segment of the import source to a file name
      // e.g. "com.example.api.service.UserService" → "UserService" → UserService.java
      const lastSegment = imp.source.split(/[./\\]/).filter(Boolean).pop();
      if (lastSegment) {
        const target = baseNameToFile.get(lastSegment);
        if (target && target !== a.filePath) {
          refSet.add(target);
        }
      }

      // 4. Resolve package/directory imports (Go, Ruby, Rust)
      // e.g. "sample-go-api/handler" → all files in handler/ directory
      // Skip if the import is from a well-known external framework (avoids
      // e.g. VB `Imports System.Windows.Forms` matching a local Forms/ dir).
      const isExternal = /^(System|Microsoft|java|javax|jakarta|org|com|io)\b/.test(imp.source);
      if (lastSegment && !isExternal) {
        const dirFiles = dirToFiles.get(lastSegment);
        if (dirFiles) {
          for (const target of dirFiles) {
            if (target !== a.filePath) refSet.add(target);
          }
        }
      }
    }

    // Also track sub-component references via pre-built path map
    for (const comp of a.subComponents) {
      if (comp.importSource) {
        const candidate = comp.importSource.replace(/^\.\//, "");
        const match = scanForSubComponent(candidate);
        if (match && match !== a.filePath) refSet.add(match);
      }
    }

    if (refSet.size > 0) {
      graph[a.filePath] = [...refSet];
    }
  }

  return graph;
}

/**
 * Enrich the component graph with edges from symbolLinks.
 * SymbolLinks represent resolved cross-file call traces — if file A calls
 * a function defined in file B, that's a dependency edge even if the import
 * resolution missed it.
 */
export function enrichGraphFromSymbolLinks(
  graph: Record<string, string[]>,
  symbolLinks: import("../types/analysis.js").SymbolLink[],
): void {
  // Pre-build edge sets for O(1) duplicate checks
  const edgeSets = new Map<string, Set<string>>();
  for (const [src, targets] of Object.entries(graph)) {
    edgeSets.set(src, new Set(targets));
  }

  for (const link of symbolLinks) {
    if (link.sourceFile === link.targetFile) continue;

    let edgeSet = edgeSets.get(link.sourceFile);
    if (!edgeSet) {
      edgeSet = new Set();
      edgeSets.set(link.sourceFile, edgeSet);
      graph[link.sourceFile] = [];
    }
    if (!edgeSet.has(link.targetFile)) {
      edgeSet.add(link.targetFile);
      graph[link.sourceFile].push(link.targetFile);
    }
  }
}

/**
 * Enrich the link graph with edges from the component graph.
 * For languages where buildLinkGraph can't resolve import sources (e.g. Go package imports),
 * the component graph may have edges that the link graph doesn't.
 */
export function enrichLinkGraphFromComponentGraph(
  linkGraph: import("../types/analysis.js").LinkInfo[],
  componentGraph: Record<string, string[]>,
): void {
  const existingEdges = new Set<string>();
  for (const link of linkGraph) {
    existingEdges.add(`${link.source}\u2192${link.target}`);
  }

  for (const [source, targets] of Object.entries(componentGraph)) {
    for (const target of targets) {
      const key = `${source}\u2192${target}`;
      if (!existingEdges.has(key)) {
        existingEdges.add(key);
        linkGraph.push({
          source,
          target,
          proximity: 3 as import("../types/analysis.js").LinkProximity,
          reason: "import dependency",
          calls: [],
        });
      }
    }
  }
}

/**
 * Infer a frontend route from file path for file-based routing frameworks.
 * Supports Next.js (pages/, app/) and Nuxt (pages/).
 */
function inferFileBasedRoute(
  relativePath: string,
  frameworkIds: string[],
): RouteInfo | null {
  const isNextjs = frameworkIds.includes("nextjs");
  const isNuxt = frameworkIds.includes("vue") || frameworkIds.includes("vue-router");

  if (!isNextjs && !isNuxt) return null;

  const normalized = relativePath.replace(/\\/g, "/");

  // Next.js pages/ directory
  let match = normalized.match(/^(?:src\/)?pages\/(.+)\.(tsx?|jsx?)$/);
  if (match) {
    const route = filePathToRoute(match[1]);
    if (route === "/_app" || route === "/_document" || route === "/api") return null;
    return {
      path: route,
      httpMethod: null,
      kind: route.startsWith("/api/") ? "api" : "frontend",
      handler: null,
      calls: [],
      middleware: [],
      line: 1,
    };
  }

  // Next.js app/ directory (page.tsx)
  match = normalized.match(/^(?:src\/)?app\/(.+)\/page\.(tsx?|jsx?)$/);
  if (match) {
    return {
      path: filePathToRoute(match[1]),
      httpMethod: null,
      kind: "frontend",
      handler: null,
      calls: [],
      middleware: [],
      line: 1,
    };
  }

  // Next.js app/ route handlers (route.ts)
  match = normalized.match(/^(?:src\/)?app\/(.+)\/route\.(tsx?|jsx?)$/);
  if (match) {
    return {
      path: filePathToRoute(match[1]),
      httpMethod: null,
      kind: "api",
      handler: null,
      calls: [],
      middleware: [],
      line: 1,
    };
  }

  // Nuxt pages/ directory
  match = normalized.match(/^pages\/(.+)\.vue$/);
  if (match) {
    return {
      path: filePathToRoute(match[1]),
      httpMethod: null,
      kind: "frontend",
      handler: null,
      calls: [],
      middleware: [],
      line: 1,
    };
  }

  return null;
}

/** Convert file path segments to a route path */
function filePathToRoute(filePath: string): string {
  return (
    "/" +
    filePath
      .replace(/\/index$/, "") // index.tsx -> /
      .replace(/\[\.\.\.(\w+)\]/g, "*") // [...slug] -> *
      .replace(/\[(\w+)\]/g, ":$1") // [id] -> :id
  );
}

import type { ImportInfo, RouteInfo } from "../types/analysis.js";

/** Import source patterns → framework id */
const IMPORT_FRAMEWORK_MAP: Record<string, string> = {
  "react": "react",
  "react-dom": "react",
  "react-router": "react-router",
  "react-router-dom": "react-router",
  "next": "nextjs",
  "next/router": "nextjs",
  "next/navigation": "nextjs",
  "vue": "vue",
  "vue-router": "vue-router",
  "nuxt": "nuxt",
  "pinia": "pinia",
  "vuex": "vuex",
  "express": "express",
  "@nestjs/common": "nestjs",
  "@nestjs/core": "nestjs",
  "fastify": "fastify",
  "@angular/core": "angular",
  "@angular/router": "angular",
  "react-redux": "react-redux",
  "@reduxjs/toolkit": "redux",
  "@tanstack/react-query": "react-query",
  "io.ktor.server.routing": "ktor",
  "org.springframework.web.bind.annotation": "spring-web",
  // ORM imports
  "@prisma/client": "prisma",
  "prisma": "prisma",
  "typeorm": "typeorm",
  "sequelize": "sequelize",
  "sequelize-typescript": "sequelize",
  "drizzle-orm": "drizzle",
  "@mikro-orm/core": "mikro-orm",
  "mongoose": "mongoose",
  "knex": "knex",
  "objection": "objection",
  "sqlalchemy": "sqlalchemy",
  "django.db.models": "django-orm",
  "tortoise": "tortoise-orm",
  "peewee": "peewee",
  "Microsoft.EntityFrameworkCore": "ef-core",
  "System.Data.Entity": "ef6",
  "Dapper": "dapper",
  "NHibernate": "nhibernate",
  "org.hibernate": "hibernate",
  "javax.persistence": "hibernate",
  "jakarta.persistence": "hibernate",
  "org.springframework.data.jpa": "spring-data-jpa",
  "org.mybatis": "mybatis",
  "org.jooq": "jooq",
  "org.jetbrains.exposed": "exposed",
  "active_record": "active-record",
  "sequel": "sequel",
  "Doctrine\\ORM": "doctrine",
  "Illuminate\\Database": "eloquent",
  "gorm.io/gorm": "gorm",
  "github.com/jmoiron/sqlx": "sqlx",
  "entgo.io/ent": "ent",
  "diesel": "diesel",
  "sea_orm": "sea-orm",
  "sqlx": "rust-sqlx",
};

/**
 * Infer which frameworks a specific file uses, based on its imports.
 * Only includes project-level frameworks that the file actually references.
 */
function inferFileFrameworks(
  imports: ImportInfo[],
  filePath: string,
  projectFrameworkIds: string[],
): string[] {
  const fileFrameworks = new Set<string>();

  for (const imp of imports) {
    // Check exact match
    const exact = IMPORT_FRAMEWORK_MAP[imp.source];
    if (exact) {
      fileFrameworks.add(exact);
      continue;
    }
    // Check prefix match (e.g., "react-router-dom/..." or "org.springframework.web.bind.annotation.*")
    for (const [pattern, fwId] of Object.entries(IMPORT_FRAMEWORK_MAP)) {
      if (imp.source.startsWith(pattern + "/") || imp.source.startsWith(pattern + ".")) {
        fileFrameworks.add(fwId);
      }
    }
  }

  // .vue files are implicitly Vue
  if (filePath.endsWith(".vue")) {
    fileFrameworks.add("vue");
  }

  return [...fileFrameworks];
}

/** Detect 'use client' / 'use server' directives (React Server Components) */
function detectDirectives(
  sourceText: string,
  analysis: FileAnalysis,
) {
  const firstLine = sourceText.trimStart().split("\n")[0];
  if (firstLine.includes("'use client'") || firstLine.includes('"use client"')) {
    analysis.dataSources.push({
      kind: "prop",
      name: "use client",
      target: "React Server Component: client boundary",
      calls: [],
      line: 1,
    });
  }
  if (firstLine.includes("'use server'") || firstLine.includes('"use server"')) {
    analysis.dataSources.push({
      kind: "prop",
      name: "use server",
      target: "React Server Component: server action",
      calls: [],
      line: 1,
    });
  }
}
