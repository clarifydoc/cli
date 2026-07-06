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
  detectFrameworksAcrossRoots,
} from "./framework-detector.js";
import {
  collectExternalPackages,
  collectComposerAutoload,
  attachPackageUsage,
  deriveFrameworksFromPackages,
  mergeFrameworkDetections,
} from "./dependency-inventory.js";
import { detectSubProjects, assignProjectId } from "./project-detector.js";
import { detectDeployment } from "./deployment.js";
import { detectFileBasedRoutes } from "../extractors/plugins/javascript/routes/file-based.js";
import { resolveExpressMounts } from "../extractors/plugins/javascript/routes/express-mounts.js";
import { resolveUrlBuilders } from "../extractors/plugins/javascript/url-builders.js";
import {
  writeProjectSummary,
  writeLspGroundTruth,
  type OutputOptions,
} from "./output-writer.js";
import { analyzeFile, type FileTask, type FileResult } from "./file-analyzer.js";
import { AnalysisWorkerPool } from "./worker-pool.js";
import { loadTsconfigAliases } from "../extractors/shared/tsconfig-aliases.js";
import { buildLinkGraph, isExternalPackage } from "../extractors/shared/link-scoring.js";
import { STRIP_SOURCE_EXTENSION_RE, EXTERNAL_NAMESPACE_ROOT_RE } from "../extractors/registry.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import { aggregateComplexity } from "./complexity-analyzer.js";
import { detectPatterns } from "./pattern-detector.js";
import { detectDuplicates } from "./duplication-detector.js";
import { classifyFileLayers, detectLayerViolations } from "./layer-analyzer.js";
import { analyzeBlastRadius } from "./blast-radius.js";
import { analyzeUnusedCode } from "./dead-code.js";
import { computeHealthScore } from "./health-scorer.js";
import { generateSuggestions } from "./suggestions-engine.js";
import { detectCommunities } from "./community-detector.js";
import { findGodNodes, findSurprisingConnections, suggestQuestions } from "./topology-analyzer.js";
import { dedupSymbolLinks, dropNameCollisionReferences } from "./symbol-dedup.js";
import { synthesizeApiRouteSymbolLinks, synthesizeQueueSymbolLinks } from "./api-route-symbol-links.js";
import { aggregateTypeBlast, buildClassGraph } from "./data-model-blast.js";
import { buildDataAccessGraph, attributeDataAccessToSymbols } from "./data-access-graph.js";
import { buildEntityGraph, reconcileEntityInheritance, linkEntityModels, synthesizeReferencedTableEntities } from "./entity-graph.js";
import { reconcileProjectEntities } from "../extractors/entities/index.js";
import { detectMigrations } from "./migration-detector.js";
import { linkApiCallsToRoutes, dedupeRoutes } from "./route-linker.js";
import { resolveProjectDispatch } from "../extractors/dispatch/index.js";
import { buildComponentLaunches } from "./component-launches.js";
import { buildImportIndex, resolveImportSource, type ImportIndex } from "./import-index.js";
import { denormalizeFileAnalysis } from "./element-registry.js";
import {
  type FileAnalysis,
  type Language,
  type ProjectAnalysis,
  type ScreenInfo,
  type ScreenComponentInfo,
  type ScreenComponentCategory,
  type ComplexityInfo,
  type SecurityIssue,
  type TemplateComponentNode,
  type EntityGraph,
  type DataAccessGraph,
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
    // denormalizeFileAnalysis no-ops on old-format (pre-registry) artifacts.
    analysis = denormalizeFileAnalysis(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!analysis || !analysis.filePath) return null;

  // Pull per-file complexity/security out of the cached analysis so the
  // project-level aggregators see the same data they would from a fresh parse.
  const complexities = analysis.complexities ?? [];
  const securityIssues = analysis.securityIssues ?? [];

  // Keep the raw source for files that can back a screen: route-config files
  // (caption/nav) AND the UI component files routes resolve to (Vue/JSX/TSX, or
  // anything with template components / interactive elements). buildScreen
  // re-parses the .vue template from this to recover its nesting + v-for.
  const hasFrontendRoute = (analysis.routes ?? []).some((r) => r.kind === "frontend");
  const isUiSource =
    hasFrontendRoute ||
    /\.(vue|svelte|jsx|tsx)$/.test(analysis.filePath) ||
    (analysis.subComponents?.length ?? 0) > 0 ||
    (analysis.interactiveElements?.length ?? 0) > 0;
  let rawSource: string | null = null;
  if (isUiSource) {
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

  // Step 2: Detect sub-projects (monorepo packages, multi-language repos) FIRST,
  // so framework detection can scan each sub-project's own (often nested) manifests.
  progress.step("Detecting sub-projects...");
  const subProjects = await detectSubProjects(projectRoot);

  // Step 2b: Detect frameworks at the root AND inside each sub-project root.
  progress.step("Detecting frameworks...");
  const { merged: ruleFrameworks, byRoot: frameworksByRoot } = await detectFrameworksAcrossRoots(
    projectRoot,
    subProjects.map((sp) => sp.root),
  );
  for (const sp of subProjects) {
    const fws = frameworksByRoot.get(sp.root);
    if (fws && fws.length > 0) sp.frameworks = fws;
  }

  // Step 2c: Build the full external-dependency inventory across every manifest
  // ecosystem, then fold the frameworks it recognises into the rule-based set
  // (rule-based wins on id collisions; the inventory adds the long tail). This
  // happens before per-file analysis so derived ids (e.g. nextjs/nuxt) reach the
  // route detectors via `frameworkIds`; per-package usage is attached afterward.
  const externalPackages = await collectExternalPackages(
    projectRoot,
    subProjects.map((sp) => sp.root),
  );
  // PHP namespace→package map from vendor/ (makes Composer usage reliable; empty if absent).
  const composerAutoload = await collectComposerAutoload(
    projectRoot,
    subProjects.map((sp) => sp.root),
  );
  const frameworks = mergeFrameworkDetections(
    ruleFrameworks,
    deriveFrameworksFromPackages(externalPackages),
  );
  const frameworkIds = frameworks.map((f) => f.id);

  progress.detail(
    frameworks.length > 0
      ? `Detected: ${frameworks.map((f) => f.name).join(", ")}`
      : "No frameworks detected",
  );

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

  // Step 2d: Deployment topology from compose manifests — which units actually
  // deploy, their infrastructure, and env-evidenced service→service edges.
  // Feeds the report's Context/Deployment (C1/C2) architecture levels.
  const deployment = await detectDeployment(projectRoot, { subProjects, fileProjects });
  if (deployment) {
    progress.detail(
      `Deployment: ${deployment.services.length} compose service${deployment.services.length === 1 ? "" : "s"}, ` +
        `${deployment.edges.length} edges (${deployment.composeFiles.length} compose file${deployment.composeFiles.length === 1 ? "" : "s"})`,
    );
  }

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

  // File-based ("auto") frontend routes: plugins like unplugin-vue-router /
  // vite-plugin-pages generate the route table from a page-file directory, so
  // the routes are not present as source. Synthesize them from the file tree
  // (reads each candidate root's Vite config to detect the convention) and push
  // them onto the page files' analyses so they flow into the route map, screens,
  // and the screen→API links below. Runs BEFORE buildSymbolLinks so these routes
  // get trace anchors like any extracted route (they used to be invisible to the
  // linker and the Routes tab had no handler links for them). Project-level +
  // in-memory (no per-file JSON change), so it needs no version bump.
  const autoRouteCount = await detectFileBasedRoutes(
    allAnalyses,
    projectRoot,
    subProjects.map((sp) => sp.root),
  );
  if (autoRouteCount > 0 && verbose) {
    progress.detail(`  file-based routes: ${autoRouteCount}`);
  }

  // Step 4: Post-analysis
  progress.step("Building dependency graph...");
  const componentGraph = buildComponentGraph(allAnalyses);
  progress.status("Building link graph...");
  const linkGraph = buildLinkGraph(allAnalyses);
  progress.status("Resolving cross-file symbols...");
  let symbolLinks = dedupSymbolLinks(buildSymbolLinks(allAnalyses));

  // Resolve dispatch indirection (mediator / command-bus) the generic linker
  // can't see: a controller's `Send(new XQuery())` has no call edge to the
  // handler's Handle method. Language plugins contribute these links; core stays
  // framework-agnostic. Added before LSP + graph enrichment so they flow into
  // the component/link graphs and any LSP pass treats them as existing links.
  const dispatchLinks = resolveProjectDispatch(allAnalyses);
  if (dispatchLinks.length > 0) {
    symbolLinks = dedupSymbolLinks([...symbolLinks, ...dispatchLinks]);
    progress.detail(`  Dispatch links: ${dispatchLinks.length}`);
  }

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
        // Export the raw query/answer log so the text linker can be optimized
        // against what LSP resolved (compare with scripts/lsp-compare.mjs).
        const groundTruthPath = await writeLspGroundTruth(projectRoot, lspResult, outputOpts);
        progress.detail(`  LSP ground truth: ${groundTruthPath}`);
      }
    } catch (err) {
      progress.detail(`LSP enhancement skipped: ${(err as Error).message}`);
    }
  }
  // Drop same-name definition-collision "references" (e.g. three microservices
  // each defining `InternalsController.Ping` get cross-linked by LSP/text
  // reference resolution into a false clique → bogus circular dependency). Must
  // run before graph enrichment so the false edges never reach the graph.
  symbolLinks = dropNameCollisionReferences(symbolLinks, allAnalyses);

  // Enrich component graph with edges from symbol links
  // This catches cross-file dependencies that import resolution missed
  // (e.g. Java package imports, Python absolute imports, C# usings)
  enrichGraphFromSymbolLinks(componentGraph, symbolLinks);

  // Enrich link graph from component graph edges that buildLinkGraph missed
  // (e.g. Go package imports resolved via directory matching)
  enrichLinkGraphFromComponentGraph(linkGraph, componentGraph);

  // Dynamic-import "opens component" edges (dialogs, lazy components) derived
  // from the finalized symbol links.
  const componentLaunches = buildComponentLaunches(symbolLinks);

  // One project-wide import index, shared across the Express mount resolver and
  // every serial builder that resolves cross-file references (screens, type
  // blast, class graph). Building it once avoids re-iterating all imports.
  const importIndex = buildImportIndex(allAnalyses);

  // Express router mounts: `app.use("/api/auth", authRoutes)` in the entry file
  // prefixes the bare router-level paths declared in another file. Resolve the
  // mount identifier through the import index and apply the prefix so routes
  // carry their full path and the screen→API join can match them. Project-level
  // + in-memory (mirrors reconcileProjectEntities); no per-file JSON change.
  const mountedRouteCount = resolveExpressMounts(allAnalyses, importIndex);
  if (mountedRouteCount > 0 && verbose) {
    progress.detail(`  mounted routes prefixed: ${mountedRouteCount}`);
  }

  // Collapse the same endpoint declared twice (Rails: `routes.rb` expansion +
  // controller-action convention) into one richest entry, so the route map and
  // the cross-tier linker don't double-count or pick a code-less handler.
  const allRoutes = dedupeRoutes(
    allAnalyses.flatMap((a) => a.routes.map((r) => ({ ...r, filePath: a.filePath }))),
  );
  const allInteractiveElements = allAnalyses.flatMap((a) =>
    a.interactiveElements.map((el) => ({ ...el, filePath: a.filePath })),
  );
  const allEvents = allAnalyses.flatMap((a) =>
    a.events.map((ev) => ({ ...ev, filePath: a.filePath })),
  );
  const allComponentUsage = allAnalyses.flatMap((a) =>
    a.subComponents.map((c) => ({ ...c, filePath: a.filePath })),
  );
  // Aggregate outbound API calls (kind=api-call data sources)
  const allApiCalls = allAnalyses.flatMap((a) =>
    a.dataSources
      .filter((ds) => ds.kind === "api-call")
      .map((ds) => ({ ...ds, filePath: a.filePath })),
  );
  // Resolve URL-builder helper calls in api-call targets
  // (`axios.get(requestUri('vikarbesked','v4'))` → `/api/v4/institution/{}/vikarbesked`)
  // so frontend calls funneled through a project URL helper carry a concrete
  // path the cross-tier linker can join. Project-level + in-memory (operates on
  // the aggregated copies; no per-file JSON change), mirroring resolveExpressMounts.
  const resolvedUrlCount = resolveUrlBuilders(allApiCalls, allAnalyses);
  if (resolvedUrlCount > 0 && verbose) {
    progress.detail(`  URL-builder calls resolved: ${resolvedUrlCount}`);
  }
  // Build screens: DFM screens + web screens from routes + routeless UI
  // component files (so their component tree shows in the "Components" group).
  const dfmScreens = allAnalyses.flatMap((a) => a.screens ?? []);
  const webScreens = buildScreensFromRoutes(allAnalyses, rawSources, importIndex);
  const screenedFiles = new Set(webScreens.map((s) => s.filePath));
  const componentScreens = buildScreensFromComponents(allAnalyses, rawSources, screenedFiles);
  const allScreens = [...dfmScreens, ...webScreens, ...componentScreens];

  // Cross-tier join: match each outbound api-call to the inbound route serving
  // it (by HTTP method + normalized path). Connects the two halves of the
  // screen→API→DB chain that the extractors produce independently.
  const apiRouteLinks = linkApiCallsToRoutes(allApiCalls, allRoutes);
  if (apiRouteLinks.length > 0) {
    progress.detail(`  API↔route links: ${apiRouteLinks.length}`);
  }

  // Turn the api↔route join into call-graph edges (frontend caller → route
  // handler) so Call Traces cross the HTTP boundary — without these, a click
  // handler's trace stops at fetch() and the backend trace starts fresh, and
  // the trace view's transitive entity propagation can never reach a screen.
  // Appended after enrichGraphFromSymbolLinks ran, so the component dependency
  // graph is untouched; blast radius (below) does include them — a handler's
  // blast genuinely covers the screens that call it.
  const apiSymbolLinks = synthesizeApiRouteSymbolLinks(apiRouteLinks, allAnalyses);
  if (apiSymbolLinks.length > 0) {
    symbolLinks = dedupSymbolLinks([...symbolLinks, ...apiSymbolLinks]);
    progress.detail(`  API→handler trace links: ${apiSymbolLinks.length}`);
  }

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
  const typeBlastMap = aggregateTypeBlast(allAnalyses, importIndex);
  for (const info of blastRadius) {
    const summaries = typeBlastMap.get(info.filePath);
    if (summaries && summaries.length > 0) {
      info.typeUsages = summaries;
    }
  }

  // Auto-detect generated/library barrel trees and the unused files within
  // them (e.g. kubb output where only a handful of endpoints are imported).
  const { generatedRoots, unusedFiles } = analyzeUnusedCode(allAnalyses, componentGraph);
  if (unusedFiles.length > 0) {
    progress.detail(`  Unused (generated): ${unusedFiles.length} file(s) under ${generatedRoots.join(", ")}`);
  }

  // Class-level dependency graph for the Architecture tab's Data Models view.
  const classGraph = buildClassGraph(allAnalyses, importIndex);

  // Entity/data-access aggregation only produces output when the project has
  // ORM entities or DB calls. On pure-frontend codebases these markers are
  // absent, so skip ~6 full passes + a 50-iteration inheritance fixpoint — the
  // builders would only return empty graphs anyway, so output is identical.
  // `.some()` short-circuits, so this is near-free on projects that do have them.
  const hasEntities = allAnalyses.some((a) =>
    a.classes?.some((c) => {
      const d = c.decorators;
      return !!d && (d.includes("entity") || d.includes("table") || d.includes("enum"));
    }),
  );
  const hasDbAccess = allAnalyses.some((a) =>
    a.dataSources?.some((ds) => ds.kind === "database"),
  );
  const hasQueueAccess = allAnalyses.some((a) =>
    a.dataSources?.some((ds) => ds.kind === "queue-publish" || ds.kind === "queue-consume"),
  );

  // File→datastore graph for the Architecture tab's Data Access view.
  const dataAccessGraph: DataAccessGraph = hasDbAccess || hasQueueAccess
    ? buildDataAccessGraph(allAnalyses)
    : { nodes: [], edges: [] };

  if (hasEntities) {
    // Resolve cross-file inheritance (custom base classes, STI chains) so models
    // that subclass a project base in another file are recognized as entities.
    reconcileEntityInheritance(allAnalyses);
    // Language-specific cross-file entity reconciliation (e.g. Rails joining
    // `db/schema.rb` columns onto its models). Each plugin's entity extractor
    // contributes its own pass; core stays language-agnostic.
    reconcileProjectEntities(allAnalyses);
  }
  // Entity-relationship graph for the "Data Model" (ER diagram) view.
  const entityGraph: EntityGraph = hasEntities
    ? buildEntityGraph(allAnalyses)
    : { nodes: [], edges: [] };
  // Cross-link: attach to each entity the data/view models that reference it in
  // type position, derived from the already-resolved ClassGraph edges. (The
  // ClassGraph nodes are themselves tagged isEntity/orm inside buildClassGraph.)
  if (hasEntities) linkEntityModels(entityGraph, classGraph);
  // Add ER nodes for tables that are queried but never modeled as an ORM entity
  // (CodeIgniter/knex/raw-SQL — the table is a bare string in `$this->db->get('x')`).
  // Deduped against the real entities above, so ORM projects are unchanged; this
  // populates the Data Model tab and lets the DB accesses below match (green).
  if (hasDbAccess) synthesizeReferencedTableEntities(allAnalyses, entityGraph);

  // Bridge Call Traces ↔ Data Model: attribute each DB access to its containing
  // function and match the touched entity to an ER node. Drives the entity
  // badges on traces and the "Accessed by" list on entities. Only DB/queue
  // calls produce entries, so skipping when none is output-identical.
  const symbolDataAccess = hasDbAccess || hasQueueAccess
    ? attributeDataAccessToSymbols(allAnalyses, entityGraph)
    : [];

  // Broker hop for Call Traces: a publish and a consume naming the same
  // destination become a publisher→consumer edge, so a trace follows the
  // message across the queue the way apiSymbolLinks follow HTTP.
  const queueSymbolLinks = synthesizeQueueSymbolLinks(symbolDataAccess);
  if (queueSymbolLinks.length > 0) {
    symbolLinks = dedupSymbolLinks([...symbolLinks, ...queueSymbolLinks]);
    progress.detail(`  MQ publish→consume trace links: ${queueSymbolLinks.length}`);
  }

  // ORM/DB migrations across known ecosystems (path-convention based).
  const migrations = detectMigrations(allAnalyses.map((a) => a.filePath));
  if (migrations.length > 0) {
    progress.detail(`  Migrations: ${migrations.length} across ${new Set(migrations.map((mig) => mig.ecosystem)).size} ecosystem(s)`);
  }

  const healthScore = computeHealthScore({
    analyses: allAnalyses,
    componentGraph,
    patterns,
    securityIssues: allSecurityIssues,
    duplicates,
    complexity,
    layerViolations,
    // Exclude generated barrel trees (kubb, …) so the grade reflects authored code.
    generatedRoots,
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
    unusedFiles,
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

  // Cross-reference the dependency inventory against the imports we extracted,
  // marking each package used/unused (where the ecosystem mapping is reliable).
  attachPackageUsage(externalPackages, allAnalyses, { composerAutoload });

  // Step 5: Write project summary
  const summary: ProjectAnalysis = {
    projectRoot,
    detectedFrameworks: frameworks,
    externalPackages: externalPackages.length > 0 ? externalPackages : undefined,
    subProjects,
    fileProjects,
    files: allAnalyses.map((a) => a.filePath),
    componentGraph,
    linkGraph,
    interactiveElements: allInteractiveElements,
    componentUsage: allComponentUsage,
    events: allEvents,
    routeMap: allRoutes,
    apiCalls: allApiCalls,
    screens: allScreens,
    symbolLinks,
    componentLaunches: componentLaunches.length ? componentLaunches : undefined,
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
    entityGraph: entityGraph.nodes.length > 0 ? entityGraph : undefined,
    symbolDataAccess: symbolDataAccess.length > 0 ? symbolDataAccess : undefined,
    migrations: migrations.length > 0 ? migrations : undefined,
    apiRouteLinks: apiRouteLinks.length > 0 ? apiRouteLinks : undefined,
    generatedRoots: generatedRoots.length > 0 ? generatedRoots : undefined,
    unusedFiles: unusedFiles.length > 0 ? unusedFiles : undefined,
    deployment,
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
  // Plain HTML page: fall back to the document <title>.
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim().replace(/\s+/g, " ") || null;
  return null;
}

/** Extract navigation targets from source (navigate(), router.push(), Link, href) */
function extractNavigationTargets(source: string): string[] {
  const targets = new Set<string>();
  const patterns = [
    /navigate\(\s*['"`]([^'"`\s]+)['"`]/g,
    /router\.push\(\s*['"`]([^'"`\s]+)['"`]/g,
    /<Link\s+[^>]*to\s*=\s*['"`]([^'"`]+)['"`]/g,
    // Programmatic page navigation in vanilla JS: `location.href = "x.html"`.
    /location(?:\.href)?\s*=\s*['"`]([^'"`]+)['"`]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const path = m[1];
      if (path && path.startsWith("/")) targets.add(path);
    }
  }
  // Plain-HTML page navigation: `<a href="other.html">`. Restricted to local
  // `.html`/`.htm` targets (no scheme, anchor, or mailto) so it adds nothing on
  // framework SPAs (which route by path, not by .html files).
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*['"`]([^'"`#][^'"`]*?\.html?)(?:[?#][^'"`]*)?['"`]/gi;
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(source)) !== null) {
    const href = am[1];
    if (/^(https?:|\/\/|mailto:|tel:|javascript:)/i.test(href)) continue;
    targets.add(href);
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
  importIndex: ImportIndex = buildImportIndex(allAnalyses),
): ScreenInfo[] {
  const byPath = new Map(allAnalyses.map((a) => [a.filePath, a]));
  const knownFiles = new Set(byPath.keys());

  // Follow a route's `component` to the concrete project file it renders.
  // Relative/absolute specifiers (lazy `import("./pak.vue")` paths) resolve
  // against the route-config file; a bare identifier (statically-imported
  // component) is looked up through that file's own imports.
  const resolveComponentFile = (configFile: string, route: RouteInfo): string | null => {
    const spec = route.componentPath;
    if (!spec) return null;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      return resolveImportSource(configFile, spec, knownFiles);
    }
    return importIndex.localFor(configFile, spec);
  };

  // A page component reached by several routes (e.g. "/pak" and
  // "/pak/:id/date/:date") is one screen, keyed by its file.
  const byComponent = new Map<string, { analysis: FileAnalysis; routes: RouteInfo[] }>();
  // Route-config files whose routes resolve to no project file: the routes are
  // declared inline in a page (React-style), so the file itself is the screen.
  const inline: Array<{ analysis: FileAnalysis; route: RouteInfo }> = [];

  for (const analysis of allAnalyses) {
    const frontendRoutes = analysis.routes.filter((r) => r.kind === "frontend");
    if (frontendRoutes.length === 0) continue;

    let resolvedAny = false;
    for (const route of frontendRoutes) {
      const targetFile = resolveComponentFile(analysis.filePath, route);
      const target =
        targetFile && targetFile !== analysis.filePath ? byPath.get(targetFile) : null;
      if (!target) continue;
      const entry = byComponent.get(target.filePath) ?? { analysis: target, routes: [] };
      entry.routes.push(route);
      byComponent.set(target.filePath, entry);
      resolvedAny = true;
    }
    if (!resolvedAny) inline.push({ analysis, route: frontendRoutes[0] });
  }

  const screens: ScreenInfo[] = [];

  for (const { analysis, routes } of byComponent.values()) {
    // Canonical path = the shortest (least-parameterised) route to the page.
    const primary = routes.slice().sort((a, b) => a.path.length - b.path.length)[0]!;
    const screenName = primary.handler ?? screenNameFromFile(analysis);
    screens.push(buildScreen(analysis, screenName, primary.path, rawSources));
  }

  for (const { analysis, route } of inline) {
    // Routes declared inline in the page file: name the screen after the file
    // (unchanged from the original behaviour for React-style/single-file pages).
    screens.push(buildScreen(analysis, screenNameFromFile(analysis), route.path, rawSources));
  }

  return screens;
}

/**
 * Build screens for reusable UI component files (EmploymentOverview.vue, …) that
 * aren't reached by any route, so the Screens & UI tab can show their component
 * tree too — not just routed pages. Each becomes a routeless screen (so it lands
 * in the "Components" group). Only files that actually yield a component tree are
 * kept; logic-only modules and components with no template/sub-components are
 * skipped. `alreadyScreened` excludes files already covered by route screens.
 */
function buildScreensFromComponents(
  allAnalyses: FileAnalysis[],
  rawSources: Map<string, string>,
  alreadyScreened: Set<string>,
): ScreenInfo[] {
  const screens: ScreenInfo[] = [];
  for (const analysis of allAnalyses) {
    if (alreadyScreened.has(analysis.filePath)) continue;
    // Frontend SFC/JSX files, OR any file that yielded a component tree (e.g. an
    // Angular `.ts` component with an inline `@Component` template).
    const hasTree = (analysis.templateTree?.length ?? 0) > 0;
    if (!hasTree && !/\.(vue|svelte|jsx|tsx|razor)$/.test(analysis.filePath)) continue;
    const screen = buildScreen(
      analysis,
      screenNameFromFile(analysis),
      "",
      rawSources,
      /* isComponent */ true,
    );
    // Skip files that produced nothing to show (no template nesting, no
    // sub-components, no interactive elements) — they'd render an empty tree.
    if (screen.components.length === 0) continue;
    screens.push(screen);
  }
  return screens;
}

/** Screen name fallback when a route carries no usable handler: prefer a named
 *  function/class export, then an exported function, then the file's base name. */
function screenNameFromFile(analysis: FileAnalysis): string {
  const namedExport = analysis.exports.find(
    (e) => e.name !== "default" && (e.kind === "function" || e.kind === "class"),
  );
  const defaultFn = analysis.functions.find((f) => f.isExported && f.name !== "default");
  const fileBaseName = analysis.filePath.replace(/^.*[\\/]/, "").replace(/\.\w+$/, "");
  return namedExport?.name ?? defaultFn?.name ?? fileBaseName;
}

/**
 * The screen's `formType` ("VuePage", "ReactComponent", …): a framework label
 * (by file extension, then framework hints) suffixed with Page/Component.
 */
function screenFormType(analysis: FileAnalysis, isComponent: boolean): string {
  const path = analysis.filePath;
  const fw = analysis.frameworks;
  const label = /\.html?$/.test(path)
    ? "Html"
    : path.endsWith(".razor")
    ? "Blazor"
    : path.endsWith(".vue")
    ? "Vue"
    : path.endsWith(".svelte")
      ? "Svelte"
      : fw.includes("angular")
        ? "Angular"
        : fw.includes("svelte")
          ? "Svelte"
          : fw.includes("vue") || fw.includes("vue-router")
            ? "Vue"
            : "React";
  return `${label}${isComponent ? "Component" : "Page"}`;
}

/**
 * Assemble a ScreenInfo from the page component's own analysis — its
 * sub-components (UserTable, dtpButtonDropdown, …) and interactive elements
 * become the component tree, and its source supplies the caption and
 * navigation targets. `routePath` and `name` come from the route that renders
 * the page, which may live in a separate route-config file.
 */
function buildScreen(
  analysis: FileAnalysis,
  screenName: string,
  routePath: string,
  rawSources: Map<string, string>,
  isComponent = false,
): ScreenInfo {
  const rawSource = rawSources.get(analysis.filePath) ?? "";
  const formType = screenFormType(analysis, isComponent);
  const caption = extractPageTitle(rawSource);

  const components: ScreenComponentInfo[] = [];

  // Track which interactiveElements belong to subComponents
  const usedInteractiveIndices = new Set<number>();

  // Reproduce the template's real nesting (with looped nodes marked) from the
  // framework-neutral tree built during per-file analysis (Vue SFC, React JSX,
  // Svelte, Angular). Files with no such tree fall back to the flat
  // sub-component list below.
  const templateTree = analysis.templateTree ?? [];
  if (templateTree.length > 0) {
    components.push(...treeToComponents(templateTree, analysis, usedInteractiveIndices));
  } else {
    // Flat fallback: one entry per distinct sub-component.
    for (const sub of analysis.subComponents) {
      // Attach the custom-element bindings (@event / v-model) on THIS
      // component's tag, matched by the tag's opening line — both extractors
      // record an element at the line where its tag opens. Matching by
      // prop/event NAME instead made every component with a `v-model` prop
      // absorb every `v-model` in the file.
      const compEvents: string[] = [];
      analysis.interactiveElements.forEach((el, idx) => {
        if (el.element === "custom" && el.line === sub.line) {
          compEvents.push(el.event + (el.handler ? ` → ${el.handler}` : ""));
          usedInteractiveIndices.add(idx);
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
        dataBindings: cleanBindings(sub.props, compEvents, false),
        line: sub.line,
      });
    }
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

  return {
    name: screenName,
    formType,
    caption,
    dimensions: null,
    components,
    filePath: analysis.filePath,
    routePath,
    navigatesTo: extractNavigationTargets(rawSource),
  };
}

/**
 * Drop data-bindings that are already represented elsewhere on the node, so the
 * tree reads cleanly:
 *   - `on*` / `@*` props (events, shown as event pills).
 *   - `key` when the node is in a `v-for` — it's loop bookkeeping next to the
 *     loop badge.
 *   - any prop that mirrors an `@event` (e.g. `click` ↔ `@click`, `v-model`) —
 *     the attribute parser surfaces these as both a prop and an event.
 */
function cleanBindings(props: string[], events: string[], repeated: boolean): string[] {
  const eventNames = new Set(
    events.map((e) => e.split(" ")[0]!.replace(/^@/, "").toLowerCase()),
  );
  return props.filter((p) => {
    if (p.startsWith("on") || p.startsWith("@")) return false;
    if (repeated && p.toLowerCase() === "key") return false;
    if (eventNames.has(p.toLowerCase())) return false;
    return true;
  });
}

/**
 * Convert a frontend template component tree into ScreenComponentInfo nodes,
 * preserving nesting and the `repeated` (loop) flag. Each node's event /
 * binding entries are matched by tag line, and `componentType` resolves to the
 * component's import source when one exists. Framework-neutral: the tree is
 * produced per-frontend (Vue SFC, React JSX, Svelte, Angular) and consumed here
 * uniformly.
 */
function treeToComponents(
  nodes: TemplateComponentNode[],
  analysis: FileAnalysis,
  usedInteractiveIndices: Set<number>,
): ScreenComponentInfo[] {
  return nodes.map((n) => {
    // Match this node's bindings by line. A component matches "custom"
    // interactive elements; an HTML control matches its own element kind.
    const events: string[] = [];
    let firstHandler: string | null = null;
    analysis.interactiveElements.forEach((el, idx) => {
      if (el.line !== n.line) return;
      const matches = n.element ? el.element === n.element : el.element === "custom";
      if (!matches) return;
      events.push(el.event + (el.handler ? ` → ${el.handler}` : ""));
      if (!firstHandler && el.handler) firstHandler = el.handler;
      usedInteractiveIndices.add(idx);
    });

    const importSource = n.element
      ? null
      : analysis.imports.find((imp) => imp.specifiers.includes(n.name))?.source ?? null;

    return {
      // For an HTML control, label it by its handler when there is one (e.g.
      // "datepickerDec") so the tree reads usefully, falling back to the tag.
      name: n.element ? (firstHandler ?? n.name) : n.name,
      componentType: n.element ?? importSource ?? n.name,
      category: n.element ? WEB_ELEMENT_CATEGORY[n.element] ?? "display" : "custom",
      caption: null,
      position: null,
      align: null,
      visible: true,
      repeated: n.repeated,
      children: treeToComponents(n.children, analysis, usedInteractiveIndices),
      events,
      dataBindings: cleanBindings(n.props, events, n.repeated),
      line: n.line,
    };
  });
}

/**
 * Languages where a bare import path denotes a package/directory of files, so
 * resolving its last segment to every file in a same-named directory is correct
 * (e.g. Go `import "myapp/handler"`, Rust modules, Ruby requires).
 *
 * For JS/TS/Vue and the rest, a non-relative specifier like "axios" is an npm
 * package, not a local folder — fanning it out to every file in a coincidentally
 * same-named directory produced ~O(N²) phantom edges (e.g. every generated API
 * hook wired to all 227 files under a local `axios/` dir).
 */
const PACKAGE_DIR_IMPORT_LANGS: ReadonlySet<Language> = new Set([
  "go",
  "rust",
  "ruby",
]);

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
      .replace(STRIP_SOURCE_EXTENSION_RE, "")
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

    // Symbols this file actually uses — type-position references plus called
    // names. Gates the bare-namespace fallback (step 3) so a leftover
    // `using DigitalRights.Shared.ErrorOr;` that references nothing in that
    // namespace doesn't fabricate a dependency edge to every file in it
    // (which made ErrorOr.cs look like a 259-dependent "critical" hub when
    // ~92% of those files never touch it).
    const usedNames = new Set<string>();
    for (const tr of a.typeReferences ?? []) {
      if (tr.typeName) usedNames.add(tr.typeName);
    }
    const addCallLeaves = (calls?: { name: string }[]): void => {
      for (const c of calls ?? []) {
        const leaf = c.name.split(".").pop();
        if (leaf) usedNames.add(leaf);
      }
    };
    for (const fn of a.functions ?? []) addCallLeaves(fn.calls);
    for (const cls of a.classes ?? []) {
      for (const m of cls.methods ?? []) addCallLeaves(m.calls);
    }

    for (const imp of a.imports) {
      // 1. Resolve relative imports (JS/TS/Vue) via pre-built path map.
      // Strip a trailing source extension so extension-bearing specifiers — as
      // dynamic imports tend to be (`import("./main.vue")`) — match the
      // extension-stripped keys in strippedPathToFile.
      if (imp.source.startsWith(".")) {
        const candidate = imp.source
          .replace(/^\.\//, "")
          .replace(STRIP_SOURCE_EXTENSION_RE, "");
        const match = scanForImport(candidate);
        if (match && match !== a.filePath) refSet.add(match);
        continue;
      }

      // A non-relative specifier that resolves to a known external package
      // (npm package, framework namespace root) never references local files —
      // skip all the name-collision heuristics below. e.g. `import … from "axios"`
      // must not match a local `axios/` directory, an `axios.ts` file, or any
      // local export whose name happens to collide with an imported specifier.
      const isExternal =
        EXTERNAL_NAMESPACE_ROOT_RE.test(imp.source) || isExternalPackage(imp.source);
      if (isExternal) continue;

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
          // A bare namespace import (`using X.Y.Z;`, no named binding) only
          // implies a dependency when the file actually uses a symbol named like
          // the matched file. A named import (specifiers) is a direct reference,
          // so keep it unconditionally.
          if (imp.specifiers.length > 0 || usedNames.has(lastSegment)) {
            refSet.add(target);
          }
        }
      }

      // 4. Resolve package/directory imports — only for languages where a bare
      // import path genuinely denotes a directory of files (Go, Rust, Ruby).
      // e.g. "sample-go-api/handler" → all files in handler/ directory.
      // For JS/TS/etc. this fan-out is pure name-collision noise, so it's gated.
      if (lastSegment && PACKAGE_DIR_IMPORT_LANGS.has(a.language)) {
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
    // Navigational fan-out (interface→impl) is not a real dependency — skip it
    // so it doesn't fabricate cycles across every implementor of an interface.
    if (link.navigational) continue;

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
