import { readFile } from "fs/promises";
import { resolve as pathResolve, join } from "path";
import { existsSync } from "fs";
import { discoverFiles, type DiscoveryOptions, type DiscoveredFile } from "./file-discovery.js";
import {
  EXTRACTOR_VERSION,
  loadManifest,
  saveManifest,
  cleanupStaleArtifacts,
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
import { resolveViewBySuffix, pickByPathAffinity, extensionFamily } from "../extractors/plugins/shared/path-utils.js";
import { detectFileBasedRoutes } from "../extractors/plugins/javascript/routes/file-based.js";
import { resolveAngularExternalTemplates } from "../extractors/plugins/javascript/angular-external-templates.js";
import { resolveExpressMounts } from "../extractors/plugins/javascript/routes/express-mounts.js";
import { resolveUrlBuilders } from "../extractors/plugins/javascript/url-builders.js";
import {
  writeProjectSummary,
  writeReportData,
  writeLspGroundTruth,
  writeImpactDiff,
  type OutputOptions,
} from "./output-writer.js";
import { buildReportPayload } from "./report-payload.js";
import { analyzeFile, type FileTask, type FileResult } from "./file-analyzer.js";
import { AnalysisWorkerPool } from "./worker-pool.js";
import { loadTsconfigAliases } from "../extractors/shared/tsconfig-aliases.js";
import { buildLinkGraph, isExternalPackage } from "../extractors/shared/link-scoring.js";
import {
  STRIP_SOURCE_EXTENSION_RE,
  EXTERNAL_NAMESPACE_ROOT_RE,
  ACTIVATION_FILE_LANGUAGES,
  ensureLanguagesLoaded,
  classifyKnownPackage,
} from "../extractors/registry.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import { aggregateComplexity } from "./complexity-analyzer.js";
import { detectPatterns } from "./pattern-detector.js";
import { detectDuplicates } from "./duplication-detector.js";
import { classifyFileLayers, detectLayerViolations } from "./layer-analyzer.js";
import { analyzeBlastRadius } from "./blast-radius.js";
import { attachTraceImpact } from "./trace-impact.js";
import { computeImpactDiff } from "./impact-diff.js";
import { collectGitHistory, computeHotspots, type GitHistoryResult } from "./git-history.js";
import { analyzeUnusedCode } from "./dead-code.js";
import { computeHealthScore } from "./health-scorer.js";
import { generateSuggestions } from "./suggestions-engine.js";
import { detectCommunities } from "./community-detector.js";
import { findGodNodes, findSurprisingConnections, suggestQuestions } from "./topology-analyzer.js";
import { dedupSymbolLinks, dropNameCollisionReferences } from "./symbol-dedup.js";
import { synthesizeApiRouteSymbolLinks, synthesizeQueueSymbolLinks } from "./api-route-symbol-links.js";
import { aggregateTypeBlast, buildClassGraph } from "./data-model-blast.js";
import { buildDataAccessGraph, attributeDataAccessToSymbols } from "./data-access-graph.js";
import {
  attributeApiCallsToSymbols,
  computeDataFlows,
  computeSymbolReach,
} from "./data-flow-reach.js";
import { vendoredMinoritySet } from "./security-scanner.js";
import { buildEntityGraph, reconcileEntityInheritance, propagateStiRelations, linkEntityModels, synthesizeReferencedTableEntities } from "./entity-graph.js";
import { reconcileProjectEntities } from "../extractors/entities/index.js";
import { detectMigrations } from "./migration-detector.js";
import { linkApiCallsToRoutes, dedupeRoutes } from "./route-linker.js";
import { resolveProjectDispatch } from "../extractors/dispatch/index.js";
import { buildComponentLaunches, buildFormLaunches } from "./component-launches.js";
import { buildImportIndex, resolveImportSource, resolveDataSourceStringConstants, type ImportIndex } from "./import-index.js";
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
  type FileChurnInfo,
  type HotspotInfo,
  type SymbolReachSummary,
  type DataFlowPath,
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
  /**
   * Collect git churn + hotspots (default true). Silently skipped on non-repos
   * and shallow clones; set false to keep outputs history-free (fixtures).
   */
  gitHistory?: boolean;
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
  /** Files whose content changed vs. the previous manifest (incremental runs
   *  against a prior manifest only). */
  changedFiles?: string[];
  /** Files present in the previous manifest but gone now (same condition). */
  removedFiles?: string[];
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

  // Step 2a: Lazily load the language plugins this project actually needs —
  // the languages of the discovered files, plus ecosystems whose build
  // manifests exist at the analyzed root or a sub-project root (go.mod →
  // go, pom.xml → java, …) so their `knownPackages` classify the dependency
  // inventory even with no source files of that language. Framework
  // detection needs no plugin bodies (rules are static-tier), but Step 2c
  // and everything after assume the plugins are loaded.
  const activationLangs = new Set(files.map((f) => f.language));
  for (const rel of ["", ...subProjects.map((sp) => sp.root)]) {
    for (const [name, langs] of ACTIVATION_FILE_LANGUAGES) {
      if (existsSync(join(projectRoot, ...(rel ? [rel] : []), name))) {
        for (const lang of langs) activationLangs.add(lang);
      }
    }
  }
  await ensureLanguagesLoaded(activationLangs);

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

  // Git churn is pure subprocess I/O — kick it off now so it overlaps the
  // CPU-bound per-file analysis, and await it at summary-assembly time.
  const gitHistoryPromise =
    options.gitHistory === false
      ? null
      : collectGitHistory(projectRoot, files.map((f) => f.relativePath)).catch(
          (e): GitHistoryResult => ({ skipped: (e as Error).message }),
        );

  const prevManifest = options.incremental ? await loadManifest(outputDir) : null;
  const newManifestEntries: Record<string, { mtime: number; sha256: string }> = {};
  let unchangedCount = 0;
  let reparsedCount = 0;
  // Files whose CONTENT changed since the previous manifest (changed + new).
  // Only meaningful against a prior manifest — feeds impact-latest.json.
  const changedSinceLastRun: string[] = [];

  // Per-file analysis is CPU-bound (tree-sitter + extractors), so spread it
  // across worker threads when the project is big enough to amortize worker
  // startup. Falls back to in-process analysis when workers are unavailable
  // (e.g. running from source, CLARIFYDOC_WORKERS=0, or tiny projects).
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
          if (classification.state !== "unchanged") changedSinceLastRun.push(manifestKey);
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
        if (result === null) {
          // Skipped (preprocess {skip}: generated API docs, foreign-format
          // xml…) — no output JSON was written, so a manifest entry would make
          // the NEXT incremental run "reuse" whatever stale JSON an older,
          // pre-skip run left at that path and resurrect the skipped file.
          delete newManifestEntries[manifestKey];
          return result;
        }
        if (options.incremental && !prevManifest) {
          // First-time incremental run: compute hash for manifest seed.
          const classification = await classifyFileForCache(file.absolutePath, undefined);
          newManifestEntries[manifestKey] = { mtime: classification.mtime, sha256: classification.sha256 };
        } else if (options.incremental && prevManifest && !newManifestEntries[manifestKey]) {
          const classification = await classifyFileForCache(file.absolutePath, undefined);
          newManifestEntries[manifestKey] = { mtime: classification.mtime, sha256: classification.sha256 };
        }
        reparsedCount++;
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

  // Drop skipped files from `fileProjects`. A plugin that claims a broad
  // extension (openapi → .yaml/.json, springxml → .xml) discovers every such
  // file but `preprocess` skips the non-matching ones (package.json, tsconfig,
  // k8s manifests, foreign-format xml), which produce no analysis. They were
  // assigned a project id at discovery; prune them so `fileProjects` reflects
  // the analyzed surface rather than raw discovery.
  {
    const analyzedPaths = new Set(allAnalyses.map((a) => a.filePath));
    for (const key of Object.keys(fileProjects)) {
      if (!analyzedPaths.has(key)) delete fileProjects[key];
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

  // Angular external templates (`templateUrl: './x.html'`): read each sibling
  // .html and back-fill the component's interactiveElements/templateTree, so an
  // external-template component gets the same screen + button→handler→API chain
  // an inline-template one does. Project-level + in-memory, before screens/links.
  const angularTplCount = await resolveAngularExternalTemplates(allAnalyses, projectRoot);
  if (angularTplCount > 0 && verbose) {
    progress.detail(`  angular external templates: ${angularTplCount}`);
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
  // Delphi navigates by constructing a form class rather than importing it, so
  // those edges come from the form registry instead of the link table.
  const componentLaunches = [
    ...buildComponentLaunches(symbolLinks),
    ...buildFormLaunches(allAnalyses, symbolLinks),
  ];

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
  // (`axios.get(requestUri('teamtalk','v4'))` → `/api/v4/institution/{}/teamtalk`)
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

  // Generated/vendored trees (barrel detection + conventional dirs like
  // jOOQ `…/generated/`, `vendor/`, `public/js/plugins/`) plus minified or
  // bundled artifacts are code the team doesn't author — findings inside them
  // (god objects in codegen output, duplicate helpers in a vendored library,
  // security issues in a webpack bundle) are noise, so they're dropped at
  // aggregation and the tabs and health score agree. Detected BEFORE the
  // finding detectors so their output can be filtered.
  const { generatedRoots, unusedFiles } = analyzeUnusedCode(allAnalyses, componentGraph);
  if (unusedFiles.length > 0) {
    progress.detail(`  Unused (generated): ${unusedFiles.length} file(s) under ${generatedRoots.join(", ")}`);
  }
  const minifiedFiles = new Set(allAnalyses.filter((a) => a.minified).map((a) => a.filePath));
  const vendoredFiles = vendoredMinoritySet(allAnalyses);
  const isUnauthored = (f: string): boolean => {
    if (minifiedFiles.has(f) || vendoredFiles.has(f)) return true;
    if (generatedRoots.length === 0) return false;
    const p = f.replace(/\\/g, "/");
    return generatedRoots.some((r) => p === r || p.startsWith(r + "/"));
  };
  // The per-file scanner already skips minified sources; this catches issues
  // cached by older extractor versions and everything under generatedRoots.
  const keptSecurityIssues = allSecurityIssues.filter((i) => !isUnauthored(i.filePath));
  if (keptSecurityIssues.length < allSecurityIssues.length) {
    progress.detail(`  Security: ${allSecurityIssues.length - keptSecurityIssues.length} issue(s) in generated/vendored files dropped`);
    allSecurityIssues.length = 0;
    allSecurityIssues.push(...keptSecurityIssues);
  }

  const complexity = aggregateComplexity(perFileComplexity);

  // Git history → per-file churn + churn×complexity hotspots. Skips (non-repo,
  // shallow clone, git missing) are silent unless verbose — never an error.
  let fileChurn: FileChurnInfo[] | undefined;
  let hotspots: HotspotInfo[] | undefined;
  if (gitHistoryPromise) {
    const gh = await gitHistoryPromise;
    if ("churn" in gh && gh.churn.length > 0) {
      fileChurn = gh.churn;
      hotspots = computeHotspots(gh.churn, complexity);
      progress.detail(
        `  Git history: ${gh.churn.length} file(s) across ${gh.commitCount} commit(s), ${hotspots.length} hotspot(s)`,
      );
    } else if ("skipped" in gh && verbose) {
      progress.detail(`  Git history skipped: ${gh.skipped}`);
    }
  }

  const patterns = detectPatterns(allAnalyses, frameworks).filter((p) => !isUnauthored(p.filePath));
  progress.status("Detecting duplicates and layer violations...");
  const duplicates = detectDuplicates(allAnalyses).filter(
    (d) => !d.occurrences.every((o) => isUnauthored(o.filePath)),
  );
  const fileLayerMap = classifyFileLayers(allAnalyses.map((a) => a.filePath));
  const layerViolations = detectLayerViolations(allAnalyses, componentGraph, fileLayerMap).filter(
    (v) => !isUnauthored(v.sourceFile) && !isUnauthored(v.targetFile),
  );
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
  // Resolve macro-valued raw-SQL tables (`CUE_TABLE` → "cues") through the
  // project-wide constant map BEFORE any data-access aggregation, so the
  // datastore/entity nodes carry physical table names and merge with accesses
  // that spell the table literally.
  resolveDataSourceStringConstants(allAnalyses);

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
    // Single-table-inheritance subclasses share their base's associations, not
    // just its columns — re-home the base's relations onto each subclass so STI
    // children aren't disconnected islands in the Data Model view. Runs last so
    // it also propagates any relations the plugin passes above derived.
    propagateStiRelations(allAnalyses);
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

  // Cross-tier blast: project each file's symbol-graph reach onto the UI and
  // data tiers — which screens/API routes transitively reach it, and which
  // entities/queues it ultimately touches. Runs AFTER the HTTP + MQ synthetic
  // links above so impact crosses tier boundaries the same way traces do.
  const traceImpactCount = attachTraceImpact(blastRadius, {
    symbolLinks,
    screens: allScreens,
    routes: allRoutes,
    symbolDataAccess,
    analyses: allAnalyses,
  });
  if (traceImpactCount > 0) {
    progress.detail(`  Cross-tier blast: ${traceImpactCount} file(s) with screen/route/entity reach`);
  }

  // Transitive data-access reach ("dataflow-lite"): propagate each DIRECT data
  // effect (DB / queue / outbound api-call) to every function that reaches it
  // through the call graph, so a controller that calls a repository that writes
  // the DB is shown to (transitively) touch it. Reuses the same symbol-link
  // edges (regular + synthetic HTTP/MQ) as the trace-impact pass above, so it
  // must run after them. Gated on data access — a pure frontend has no sink to
  // reach. `dataFlows` is the source→sink view (which handlers reach which
  // effects).
  let symbolReach: SymbolReachSummary[] = [];
  let dataFlows: DataFlowPath[] = [];
  if (hasDbAccess || hasQueueAccess) {
    // Per-site DB read/write classification: the plugin-set `access` on database
    // data sources (ORM verb) unioned with `db-write` mutation lines. Core only
    // unions line numbers — the verb knowledge stays in the plugins.
    const dbAccessByLine = new Map<string, "read" | "write">();
    for (const a of allAnalyses) {
      for (const ds of a.dataSources ?? []) {
        if (ds.kind === "database" && ds.access) dbAccessByLine.set(`${a.filePath}::${ds.line}`, ds.access);
      }
      for (const m of a.dataMutations ?? []) {
        if (m.kind === "db-write") dbAccessByLine.set(`${a.filePath}::${m.line}`, "write");
      }
    }
    symbolReach = computeSymbolReach({
      symbolLinks,
      symbolDataAccess,
      apiCallAccess: attributeApiCallsToSymbols(allAnalyses),
      dbAccessByLine,
    });
    dataFlows = computeDataFlows(symbolReach, allRoutes, allAnalyses);
    if (symbolReach.length > 0) {
      progress.detail(
        `  Data-flow reach: ${symbolReach.length} symbol(s), ${dataFlows.length} route→data flow(s)`,
      );
    }
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
    fileChurn,
    hotspots,
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
    symbolReach: symbolReach.length > 0 ? symbolReach : undefined,
    dataFlows: dataFlows.length > 0 ? dataFlows : undefined,
    migrations: migrations.length > 0 ? migrations : undefined,
    apiRouteLinks: apiRouteLinks.length > 0 ? apiRouteLinks : undefined,
    generatedRoots: generatedRoots.length > 0 ? generatedRoots : undefined,
    unusedFiles: unusedFiles.length > 0 ? unusedFiles : undefined,
    deployment,
  };

  progress.step("Writing project summary...");
  // Build the report payload from the in-memory (denormalized) summary BEFORE
  // writeProjectSummary, which normalizes for on-disk storage. Written so the
  // report viewer (SPA / server) can fetch it directly.
  const reportPayload = buildReportPayload(summary);
  await writeProjectSummary(summary, outputOpts);
  await writeReportData(reportPayload, outputOpts);

  // Diff-scoped impact: against a PRIOR manifest the changed set is exact, so
  // project it onto the cross-tier blast data and persist it — the application
  // server serves this on watch re-runs and the viewer's Overview renders it.
  // First incremental runs (no prior manifest) have no diff to speak of.
  let removedSinceLastRun: string[] | undefined;
  if (options.incremental && prevManifest) {
    removedSinceLastRun = Object.keys(prevManifest.entries).filter(
      (k) => !(k in newManifestEntries),
    );
    const impact = computeImpactDiff(summary, changedSinceLastRun, {
      removedFiles: removedSinceLastRun,
      baseLabel: "previous analysis run",
    });
    await writeImpactDiff(impact, outputOpts);
    if (impact.changedFiles.length > 0) {
      progress.detail(
        `  Impact: ${impact.changedFiles.length} changed → ${impact.screenCount} screen(s), ${impact.routeCount} route(s), ${impact.entityCount} entit(ies)`,
      );
    }
  }

  // Save the manifest only after the rest of the pipeline succeeds so a crash
  // mid-run leaves the previous manifest intact.
  if (options.incremental) {
    const manifest: Manifest = {
      version: 1,
      extractorVersion: EXTRACTOR_VERSION,
      entries: newManifestEntries,
    };
    await saveManifest(outputDir, manifest);
    // Remove per-file JSON for sources that disappeared since the last run so
    // the cache, the file browser, and the file count stay in sync.
    if (prevManifest) {
      const removed = await cleanupStaleArtifacts(
        outputDir,
        Object.keys(prevManifest.entries),
        new Set(Object.keys(newManifestEntries)),
      );
      if (removed > 0) progress.detail(`  Incremental: removed ${removed} stale artifact(s)`);
    }
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
    changedFiles: prevManifest ? changedSinceLastRun.sort() : undefined,
    removedFiles: removedSinceLastRun,
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
      const direct = resolveImportSource(configFile, spec, knownFiles);
      if (direct) return direct;
      // Server-rendered view path (`view="/account/details"` in a Web Flow /
      // MVC config): resolve by path suffix, tie-broken toward the config
      // file's own webapp.
      if (spec.startsWith("/")) return resolveViewBySuffix(spec, knownFiles, configFile);
      return null;
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
    // A config file whose routes all point at absolute VIEW paths is pure
    // wiring (a Web Flow XML, an MVC route table) — when none of its views
    // resolved, an inline screen of the config file itself is an empty shell,
    // not a page. Inline screens remain for route-in-page files (React) and
    // pages that route themselves (HTML, Blazor `@page`).
    const wiringOnly = frontendRoutes.every((r) => r.componentPath?.startsWith("/"));
    if (!resolvedAny && !wiringOnly) inline.push({ analysis, route: frontendRoutes[0] });
  }

  const screens: ScreenInfo[] = [];

  for (const { analysis, routes } of byComponent.values()) {
    // Canonical path = the shortest (least-parameterised) route to the page.
    const primary = routes.slice().sort((a, b) => a.path.length - b.path.length)[0]!;
    // The target's plugin may already have authored the screen (JSP views,
    // Qt Designer forms): give it the route instead of synthesizing a second
    // screen for the same file. The mutation flows into the plugin-screens
    // pass, which collects these same ScreenInfo objects.
    if (analysis.screens.length > 0) {
      for (const s of analysis.screens) {
        if (!s.routePath) s.routePath = primary.path;
      }
      continue;
    }
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
export function buildComponentGraph(
  analyses: FileAnalysis[],
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};

  // Export names / basenames map to EVERY declaring file — a repo of many
  // sibling projects repeats names freely (every Delphi project exports a
  // TForm1, every second one ships a Unit1.pas). A single-winner map made the
  // edge target an insertion-order accident; the candidate closest to the
  // importing file wins instead (same policy as link-scoring's tryMatch).
  const exportToFiles = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, file: string) => {
    const list = map.get(key);
    if (list) {
      if (!list.includes(file)) list.push(file);
    } else map.set(key, [file]);
  };
  const projectOf = new Map<string, string>();
  for (const a of analyses) {
    if (a.projectId) projectOf.set(a.filePath, a.projectId);
    for (const exp of a.exports) {
      push(exportToFiles, exp.name, a.filePath);
    }
  }
  // Cross-family edges are never real (a PHP route file cannot import a
  // Kotlin service; pit-stop's web.php grew 50+ phantom edges into
  // dsps-server). Unknown families (html, xml, …) stay eligible — an .html
  // page genuinely script-links .js files.
  const familyCompatible = (from: string, to: string): boolean => {
    const f1 = extensionFamily(from);
    const f2 = extensionFamily(to);
    return !f1 || !f2 || f1 === f2;
  };
  // Same-project candidates beat everything in a multi-project solution;
  // affinity only breaks ties within the chosen scope.
  const pickScoped = (candidates: string[], fromFile: string): string | null => {
    let others = candidates.filter((c) => c !== fromFile);
    if (others.length === 0) return null;
    // Same language family only (a Pascal `uses` never targets a .js file).
    const family = extensionFamily(fromFile);
    if (family) {
      others = others.filter((c) => extensionFamily(c) === family);
      if (others.length === 0) return null;
    }
    const srcProject = projectOf.get(fromFile);
    const sameProject = srcProject !== undefined
      ? others.filter((c) => projectOf.get(c) === srcProject)
      : [];
    return pickByPathAffinity(sameProject.length > 0 ? sameProject : others, (c) => c, fromFile);
  };

  // File base names (without extension, LOWERCASED — Pascal and friends match
  // units case-insensitively) → declaring files.
  const baseNameToFiles = new Map<string, string[]>();
  // Build a map of stripped paths to file paths for relative import resolution (O(1) lookup)
  const strippedPathToFile = new Map<string, string>();
  // Build a map of directory names → files in that directory (for Go/Rust package imports)
  const dirToFiles = new Map<string, string[]>();
  for (const a of analyses) {
    const baseName = a.filePath.replace(/^.*[\\/]/, "").replace(/\.\w+$/, "").toLowerCase();
    push(baseNameToFiles, baseName, a.filePath);
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

  // Web Component (custom element) tag → defining file(s). Usages appear in
  // markup as `<kebab-tag>` with no import, so they can't resolve by path like
  // ordinary sub-components — they resolve by tag. Keyed by a normalized form
  // (non-alphanumerics stripped, lowercased) so a `user-card` registration
  // matches a `<user-card>` / `UserCard` usage regardless of casing/separators.
  const normTag = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const customElToFiles = new Map<string, string[]>();
  for (const a of analyses) {
    for (const ce of a.customElements ?? []) push(customElToFiles, normTag(ce.tag), a.filePath);
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
    // `using TicketRights.Shared.ErrorOr;` that references nothing in that
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
        if (match && match !== a.filePath && familyCompatible(a.filePath, match)) refSet.add(match);
        continue;
      }

      // A non-relative specifier that resolves to a known external package
      // (npm package, framework namespace root) never references local files —
      // skip all the name-collision heuristics below. e.g. `import … from "axios"`
      // must not match a local `axios/` directory, an `axios.ts` file, or any
      // local export whose name happens to collide with an imported specifier.
      // The dependency-inventory catalog counts too: `@prisma/client` is a
      // known package, so its last segment must never basename-match a local
      // `client.ts` (checked as the full source and as the package root, so
      // subpath imports like `@scope/pkg/sub` still hit).
      const parts = imp.source.split("/");
      const packageRoot =
        imp.source.startsWith("@") && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
      const isExternal =
        EXTERNAL_NAMESPACE_ROOT_RE.test(imp.source) ||
        isExternalPackage(imp.source) ||
        classifyKnownPackage(imp.source) !== undefined ||
        classifyKnownPackage(packageRoot) !== undefined;
      if (isExternal) continue;

      // 2. Resolve non-relative imports via specifier names → exported names
      // Works for Java (import com.example.api.service.UserService → specifier "UserService")
      // Works for Python (from app.services import UserService → specifier "UserService")
      // Works for C# (using MyApp.Services → specifier matching)
      for (const spec of imp.specifiers) {
        if (!spec) continue;
        // A NAMESPACE import's specifier is a module/unit name, not a symbol
        // binding — matching it against exported SYMBOL names is a category
        // error unless the file actually uses a symbol so named (same gate as
        // step 3). Without it, every `uses X` in a Delphi repo grew an edge to
        // whichever type-library unit exports a symbol coincidentally named X
        // (Word_97.pas exports thousands — it collected 68 false dependents).
        if (imp.isNamespace && !usedNames.has(spec)) continue;
        const candidates = exportToFiles.get(spec);
        if (candidates) {
          // Self is dropped BEFORE the pick (an import never targets its own
          // file) so a same-named import from elsewhere can still resolve.
          const target = pickScoped(candidates, a.filePath);
          if (target) refSet.add(target);
        }
      }

      // 3. Resolve by matching the last segment of the import source to a file name
      // e.g. "com.example.api.service.UserService" → "UserService" → UserService.java
      const lastSegment = imp.source.split(/[./\\]/).filter(Boolean).pop();
      if (lastSegment) {
        const candidates = baseNameToFiles.get(lastSegment.toLowerCase());
        const target = candidates ? pickScoped(candidates, a.filePath) : null;
        if (target) {
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
        if (match && match !== a.filePath && familyCompatible(a.filePath, match)) refSet.add(match);
      }
    }

    // Web Component usages: a `<kebab-tag>` in this file's markup resolves to
    // the file that registered the tag (customElements.define / @customElement),
    // by tag rather than import path. Names come from flat sub-components and the
    // nested template tree (custom tags with no import land in both).
    if (customElToFiles.size > 0) {
      const usedNames = new Set<string>();
      for (const comp of a.subComponents) usedNames.add(comp.name);
      const collectTreeNames = (node: import("../types/analysis.js").TemplateComponentNode): void => {
        if (!node.element) usedNames.add(node.name); // skip promoted interactive elements
        for (const child of node.children) collectTreeNames(child);
      };
      for (const node of a.templateTree ?? []) collectTreeNames(node);
      for (const name of usedNames) {
        const files = customElToFiles.get(normTag(name));
        if (!files) continue;
        const target = pickByPathAffinity(files.filter((f) => f !== a.filePath), (c) => c, a.filePath);
        if (target) refSet.add(target);
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
