import { readFile } from "fs/promises";
import { discoverFiles, type DiscoveryOptions, type DiscoveredFile } from "./file-discovery.js";
import {
  gatherProjectInfo,
  detectFrameworks,
} from "./framework-detector.js";
import {
  writeFileAnalysis,
  writeProjectSummary,
  type OutputOptions,
} from "./output-writer.js";
import { parseSource } from "../parsers/parser-manager.js";
import { parseVueSfc } from "../parsers/vue-sfc.js";
import { parseDfm } from "../parsers/dfm-parser.js";
import { extractImports, extractExports } from "../extractors/imports-exports/index.js";
import { extractFunctions, extractClasses } from "../extractors/functions-classes/index.js";
import { extractSubComponents } from "../extractors/shared/sub-components.js";
import { extractRoutes } from "../extractors/routes/index.js";
import { extractDataSources } from "../extractors/data-sources/index.js";
import { extractDataMutations } from "../extractors/data-mutations/index.js";
import { classifyCalls, extractTopLevelCalls, extractVariableAliases } from "../extractors/shared/call-graph.js";
import { extractInteractiveElements, extractVueInteractiveElements } from "../extractors/shared/interactive-elements.js";
import { extractEvents } from "../extractors/shared/events.js";
import { buildLinkGraph } from "../extractors/shared/link-scoring.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import { computeComplexity, aggregateComplexity } from "./complexity-analyzer.js";
import { scanSecurity } from "./security-scanner.js";
import { detectPatterns } from "./pattern-detector.js";
import { detectDuplicates } from "./duplication-detector.js";
import { classifyFileLayers, detectLayerViolations } from "./layer-analyzer.js";
import { analyzeBlastRadius } from "./blast-radius.js";
import { computeHealthScore } from "./health-scorer.js";
import { generateSuggestions } from "./suggestions-engine.js";
import {
  createEmptyAnalysis,
  type FileAnalysis,
  type Language,
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

// ─── Per-file analysis task / result ─────────────────────────────────────

interface FileTask {
  file: DiscoveredFile;
  frameworkIds: string[];
  outputOpts: OutputOptions;
  verbose: boolean;
}

interface FileResult {
  analysis: FileAnalysis;
  rawSource: string | null; // non-null only for frontend route files
  complexities: ComplexityInfo[];
  securityIssues: SecurityIssue[];
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

// ─── Single-file analysis ────────────────────────────────────────────────

/**
 * Analyze a single file: read, parse, extract, write JSON.
 * Returns null on error (error is logged internally).
 */
async function analyzeFile(task: FileTask): Promise<FileResult | null> {
  const { file, frameworkIds, outputOpts, verbose } = task;

  try {
    const rawSource = await readFile(file.absolutePath, "utf-8");

    // .dfm files use a dedicated parser (no tree-sitter)
    if (file.language === "dfm") {
      const analysis = parseDfm(rawSource, file.relativePath);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);
      await writeFileAnalysis(analysis, outputOpts);
      return { analysis, rawSource: null, complexities: [], securityIssues: [] };
    }

    // Languages without tree-sitter grammars: use regex fallback
    const REGEX_ONLY_LANGUAGES: Language[] = ["go", "rust", "ruby", "php", "swift", "lua", "scala"];
    if (REGEX_ONLY_LANGUAGES.includes(file.language)) {
      const { extractWithRegex } = await import("./regex-extractor.js");
      const analysis = extractWithRegex(rawSource, file.relativePath, file.language);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);
      const fileSecurityIssues = scanSecurity(rawSource, file.relativePath, file.language);
      await writeFileAnalysis(analysis, outputOpts);
      return { analysis, rawSource: null, complexities: [], securityIssues: fileSecurityIssues };
    }

    const isVue = file.relativePath.endsWith(".vue");

    // For .vue files, extract the <script> block and parse that
    let sourceText: string;
    let language: Language = file.language;
    const vueSfc = isVue ? parseVueSfc(rawSource) : null;
    if (isVue) {
      if (!vueSfc!.script) {
        if (verbose) console.log(`    Skipping ${file.relativePath}: no <script> block`);
        return null;
      }
      sourceText = vueSfc!.script;
      language = vueSfc!.scriptLang;
    } else {
      sourceText = rawSource;
    }

    let tree;
    try {
      tree = await parseSource(sourceText, language as any, file.relativePath);
    } catch (parseErr) {
      // Tree-sitter parse failure: fall back to regex extraction
      if (verbose) console.log(`    Parse failed for ${file.relativePath}, using regex fallback`);
      const { extractWithRegex } = await import("./regex-extractor.js");
      const analysis = extractWithRegex(rawSource, file.relativePath, file.language);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);
      const fileSecurityIssues = scanSecurity(rawSource, file.relativePath, file.language);
      await writeFileAnalysis(analysis, outputOpts);
      return { analysis, rawSource: null, complexities: [], securityIssues: fileSecurityIssues };
    }

    const analysis = createEmptyAnalysis(file.relativePath, language);

    // Run all extractors
    analysis.imports = extractImports(tree, sourceText, language);
    analysis.exports = extractExports(tree, sourceText, language);
    analysis.functions = extractFunctions(tree, sourceText, language);
    analysis.classes = extractClasses(tree, sourceText, language);
    analysis.routes = extractRoutes(tree, sourceText, language);
    analysis.dataSources = extractDataSources(tree, sourceText, language);
    analysis.dataMutations = extractDataMutations(tree, sourceText, language);
    analysis.events = extractEvents(sourceText, language);
    analysis.subComponents = extractSubComponents(
      tree,
      sourceText,
      language,
      analysis.imports,
    );

    // Extract top-level calls (Vue <script setup>, module-level hooks)
    // and variable aliases (const userStore = useUserStore())
    const topLevelCalls = extractTopLevelCalls(tree, language);
    const variableAliases = extractVariableAliases(tree, analysis.imports, language);

    if (topLevelCalls.length > 0) {
      const setupFn = {
        name: "<setup>",
        params: [],
        returnType: null,
        isAsync: false,
        isExported: false,
        decorators: [],
        calls: topLevelCalls,
        line: 1,
        endLine: 1,
      };
      analysis.functions.unshift(setupFn);
    }

    // Classify calls using import context, language patterns, and variable aliases
    for (const fn of analysis.functions) {
      fn.calls = classifyCalls(fn.calls, analysis.imports, language, variableAliases);
    }
    for (const cls of analysis.classes) {
      for (const method of cls.methods) {
        method.calls = classifyCalls(method.calls, analysis.imports, language, variableAliases);
      }
    }
    for (const route of analysis.routes) {
      route.calls = classifyCalls(route.calls, analysis.imports, language, variableAliases);
    }
    // Also classify calls inside data source callbacks (lifecycle hooks, watchers)
    for (const ds of analysis.dataSources) {
      if (ds.calls.length > 0) {
        ds.calls = classifyCalls(ds.calls, analysis.imports, language, variableAliases);
      }
    }

    // Extract interactive elements (buttons, inputs, forms with event bindings)
    analysis.interactiveElements = extractInteractiveElements(tree, sourceText, language);

    // Infer frameworks for this specific file based on its imports
    analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);

    // For .vue files, also add template components and interactive elements
    if (isVue && vueSfc) {
      if (vueSfc.template) {
        analysis.interactiveElements.push(
          ...extractVueInteractiveElements(vueSfc.template, rawSource),
        );
      }
      for (const comp of vueSfc.templateComponents) {
        const importSource =
          analysis.imports.find((imp) =>
            imp.specifiers.includes(comp.name),
          )?.source ?? null;
        if (!analysis.subComponents.some((sc) => sc.name === comp.name)) {
          analysis.subComponents.push({
            name: comp.name,
            importSource,
            props: comp.props,
            line: comp.line,
          });
        }
      }
    }

    // Next.js / Nuxt file-based routing: infer route from file path
    const fileRoute = inferFileBasedRoute(file.relativePath, frameworkIds);
    if (fileRoute) {
      analysis.routes.push(fileRoute);
    }

    // Detect React directives: 'use client' / 'use server'
    detectDirectives(sourceText, analysis);

    // Advanced per-file analysis: complexity and security
    const fileComplexities = computeComplexity(tree, language, analysis.functions, analysis.classes);
    const fileSecurityIssues = scanSecurity(sourceText, file.relativePath, language);

    await writeFileAnalysis(analysis, outputOpts);

    // Return raw source for frontend route files (needed for screen building)
    const hasFrontendRoute = analysis.routes.some((r) => r.kind === "frontend");
    return {
      analysis,
      rawSource: hasFrontendRoute ? rawSource : null,
      complexities: fileComplexities,
      securityIssues: fileSecurityIssues,
    };
  } catch (err) {
    console.error(
      `  Error analyzing ${file.relativePath}: ${(err as Error).message}`,
    );
    if (verbose) {
      console.error((err as Error).stack);
    }
    return null;
  }
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
  const files = await discoverFiles(projectRoot, discoveryOpts);

  progress.detail(`Found ${files.length} source files`);

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

  // Step 3: Analyze each file (parallel with concurrency limit)
  progress.step(`Analyzing ${files.length} files...`);
  const outputOpts: OutputOptions = { outputDir, pretty: options.pretty };
  let completedCount = 0;

  const results = await runWithConcurrency(
    files,
    8,
    async (file, _i) => {
      progress.detail(`  Analyzing: ${file.relativePath}`);
      progress.status(`Analyzing [${completedCount}/${files.length}] ${file.relativePath}`);
      return analyzeFile({ file, frameworkIds, outputOpts, verbose: !!verbose });
    },
    () => {
      completedCount++;
    },
  );

  // Collect successful results
  const allAnalyses: FileAnalysis[] = [];
  const rawSources = new Map<string, string>();
  const perFileComplexity: { filePath: string; complexities: ComplexityInfo[] }[] = [];
  const allSecurityIssues: SecurityIssue[] = [];

  for (const result of results) {
    if (result) {
      allAnalyses.push(result.analysis);
      if (result.rawSource) {
        rawSources.set(result.analysis.filePath, result.rawSource);
      }
      if (result.complexities.length > 0) {
        perFileComplexity.push({ filePath: result.analysis.filePath, complexities: result.complexities });
      }
      allSecurityIssues.push(...result.securityIssues);
    }
  }

  // Step 4: Post-analysis
  progress.step("Building dependency graph...");
  const componentGraph = buildComponentGraph(allAnalyses);
  progress.status("Building link graph...");
  const linkGraph = buildLinkGraph(allAnalyses);
  progress.status("Resolving cross-file symbols...");
  let symbolLinks = buildSymbolLinks(allAnalyses);

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
      symbolLinks = lspResult.enhancedLinks;
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
  progress.status("Computing blast radius and health score...");
  const blastRadius = analyzeBlastRadius(componentGraph, symbolLinks, allAnalyses.length);
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

  // Step 5: Write project summary
  const summary: ProjectAnalysis = {
    projectRoot,
    detectedFrameworks: frameworks,
    files: allAnalyses.map((a) => a.filePath),
    componentGraph,
    linkGraph,
    interactiveElements: allInteractiveElements,
    events: allEvents,
    routeMap: allRoutes,
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
  };

  progress.step("Writing project summary...");
  await writeProjectSummary(summary, outputOpts);
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
      .replace(/\.(ts|tsx|js|jsx|mjs|cjs|vue|py|java|kt|cs|pas|go|rs|rb|php|swift|lua|scala)$/, "")
      .replace(/\/index$/, "");
    strippedPathToFile.set(stripped, a.filePath);

    // Map directory name → files
    const dir = a.filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
    const dirName = dir.split("/").pop() ?? dir;
    if (!dirToFiles.has(dirName)) dirToFiles.set(dirName, []);
    dirToFiles.get(dirName)!.push(a.filePath);
  }

  for (const a of analyses) {
    const refSet = new Set<string>();

    for (const imp of a.imports) {
      // 1. Resolve relative imports (JS/TS/Vue) via pre-built path map
      if (imp.source.startsWith(".")) {
        const candidate = imp.source.replace(/^\.\//, "");
        // Try direct lookup in stripped path map
        let match: string | undefined;
        for (const [stripped, filePath] of strippedPathToFile) {
          if (stripped.endsWith(candidate) || candidate.endsWith(stripped)) {
            match = filePath;
            break;
          }
        }
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
      if (lastSegment) {
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
        for (const [stripped, filePath] of strippedPathToFile) {
          if (stripped.endsWith(candidate)) {
            if (filePath !== a.filePath) refSet.add(filePath);
            break;
          }
        }
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
function enrichGraphFromSymbolLinks(
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
function enrichLinkGraphFromComponentGraph(
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
