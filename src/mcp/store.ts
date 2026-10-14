/**
 * The MCP server's view of an analysis: locate it, load it, index it, and
 * refresh it on request.
 *
 * Everything the tools answer comes from one `ProjectAnalysis` — the same
 * denormalized, LSP-merged object the HTML report renders (`loadReportSummary`),
 * so an MCP answer and the report can never disagree. The summary is cached
 * until the file on disk changes (mtime + size), which is what makes the VS Code
 * flow cheap: the extension analyzes, the server picks the new summary up on the
 * next tool call.
 */

import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import {
  AnalysisLockedError,
  currentLockHolder,
  waitFor,
  type LockOwner,
} from "../core/analysis-lock.js";
import type {
  ApiRouteLink,
  ArchLayer,
  BlastRadiusInfo,
  ComponentLaunch,
  DataSourceInfo,
  DuplicateGroup,
  EntityGraphNode,
  FileAnalysis,
  FileChurnInfo,
  FileComplexityInfo,
  LayerViolation,
  ProjectAnalysis,
  RouteInfo,
  ScreenInfo,
  SecurityIssue,
  SymbolDataAccess,
  SymbolLink,
  SymbolReachSummary,
  ResponsibilityProfile,
  RefactorPressureInfo,
  JsonSchemaNode,
} from "../types/analysis.js";
import { analyze, type AnalyzeResult } from "../core/analyzer.js";
import { loadReportSummary } from "../core/report-payload.js";

/** Routes/api-calls carry the owning file once aggregated project-wide. */
export type RouteWithFile = RouteInfo & { filePath: string; projectId?: string; requestSchema?: JsonSchemaNode };
export type ApiCallWithFile = DataSourceInfo & { filePath: string };

/** Everything the tools need about one file, pre-grouped. */
export interface FileFacts {
  path: string;
  layer?: ArchLayer;
  projectId?: string;
  routes: RouteWithFile[];
  screens: ScreenInfo[];
  apiCalls: ApiCallWithFile[];
  complexity?: FileComplexityInfo;
  security: SecurityIssue[];
  /** Layer violations where this file is the importer / the imported. */
  violationsFrom: LayerViolation[];
  violationsTo: LayerViolation[];
  /** Symbol links whose call site is here (calls out) / whose definition is here (called in). */
  outbound: SymbolLink[];
  inbound: SymbolLink[];
  dataAccess: SymbolDataAccess[];
  reach: SymbolReachSummary[];
  blast?: BlastRadiusInfo;
  churn?: FileChurnInfo;
  /** Boundary/concern profile — absent for files that touch no boundary. */
  responsibility?: ResponsibilityProfile;
  /** Composite refactor pressure — absent below the "observe" band. */
  pressure?: RefactorPressureInfo;
  duplicates: DuplicateGroup[];
  /** Frontend→backend links: calls made from here / routes served by here. */
  callsRoutes: ApiRouteLink[];
  servesCalls: ApiRouteLink[];
  /** Dynamic-import "opens component" edges out of / into this file. */
  opens: ComponentLaunch[];
  openedBy: ComponentLaunch[];
}

/** Lookup tables built once per loaded summary. */
export interface AnalysisIndex {
  byFile: Map<string, FileFacts>;
  /** Lowercased project-relative path → canonical path, for case-insensitive lookup. */
  pathLookup: Map<string, string>;
  /** Lowercased entity name → ER nodes with that name. */
  entitiesByName: Map<string, EntityGraphNode[]>;
  /** `file::symbol` (both lowercased) → symbol links defined at that symbol. */
  reachBySymbol: Map<string, SymbolReachSummary>;
}

export interface LoadedAnalysis {
  summary: ProjectAnalysis;
  index: AnalysisIndex;
  /** Absolute directory the summary was read from. */
  analysisDir: string;
}

export interface AnalyzeSettings {
  incremental?: boolean;
  lsp?: boolean;
  lspTimeout?: number;
  gitHistory?: boolean;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
}

export interface AnalysisStoreOptions {
  /** Absolute path of the project being served. */
  projectRoot: string;
  /** Absolute directory holding project-summary.json (also the analyze output dir). */
  analysisDir: string;
  /** When false, the store never re-analyzes on request — it reads what exists. */
  allowAnalyze?: boolean;
  /**
   * When false, the store will not even run the FIRST analysis for a project
   * that has none. Defaults to true: a read-only server (the VS Code
   * extension's, say) still bootstraps itself once rather than answering every
   * tool call with "run it from the editor", and the directory lock keeps that
   * one run from colliding with the editor's.
   */
  allowColdStart?: boolean;
  /**
   * Set when the first analysis must not run even though cold start is on: the
   * root is a fallback rather than a project (no marker above the working
   * directory). The home directory and a filesystem root are refused without
   * it. Asking explicitly (`clarifydoc_analyze`) still works.
   */
  coldStartRefusal?: string;
  analyzeSettings?: AnalyzeSettings;
  log?: (message: string) => void;
}

/**
 * Why `root` must not be analyzed unasked, or null. A user-scope client config
 * started from `$HOME` would otherwise scan the whole home directory before
 * answering its first tool call.
 */
export function unsafeColdStartRoot(root: string): string | null {
  const abs = resolve(root);
  if (abs === resolve(homedir())) return `${abs} is your home directory, not a project`;
  if (dirname(abs) === abs) return `${abs} is a filesystem root, not a project`;
  return null;
}

export class MissingAnalysisError extends Error {}

/** How long a cold start waits for an analysis another process is running. */
const COLD_START_WAIT_MS = 180_000;

export class AnalysisStore {
  private cached: LoadedAnalysis | null = null;
  private cacheKey = "";
  /** In-flight analysis, so two concurrent tool calls never scan twice. */
  private running: Promise<AnalyzeResult> | null = null;
  /** In-flight load, so a burst of tool calls parses the summary once. */
  private loading: { key: string; promise: Promise<LoadedAnalysis> } | null = null;
  private readonly log: (message: string) => void;

  constructor(private readonly options: AnalysisStoreOptions) {
    this.log = options.log ?? (() => {});
  }

  get projectRoot(): string {
    return this.options.projectRoot;
  }

  get analysisDir(): string {
    return this.options.analysisDir;
  }

  get allowAnalyze(): boolean {
    return this.options.allowAnalyze !== false;
  }

  /**
   * Whether this store may bootstrap a project that has never been analyzed.
   * Independent of `allowAnalyze`: --no-cold-start means "only analyze when
   * asked", and folding `allowAnalyze` in here made the flag a silent no-op
   * unless --no-auto-analyze was passed too.
   */
  get allowColdStart(): boolean {
    return this.options.allowColdStart !== false;
  }

  /** Absolute path of the summary this store reads. */
  get summaryPath(): string {
    return join(this.options.analysisDir, "project-summary.json");
  }

  /** True when an analysis exists on disk. */
  async exists(): Promise<boolean> {
    return (await statOrNull(this.summaryPath)) !== null;
  }

  /**
   * The current analysis. Runs one automatically when nothing exists yet (unless
   * `allowAnalyze` is false) so a fresh client is useful without a manual step.
   */
  async load(): Promise<LoadedAnalysis> {
    let info = await statOrNull(this.summaryPath);
    if (!info) info = await this.coldStart();

    const key = `${info.mtimeMs}:${info.size}`;
    if (this.cached && this.cacheKey === key) return this.cached;
    // Tool calls arrive concurrently; without this a burst would each parse and
    // index the whole summary before the first one populated the cache.
    if (this.loading?.key === key) return this.loading.promise;

    const promise = (async () => {
      const summary = await loadReportSummary(this.options.analysisDir);
      const loaded: LoadedAnalysis = {
        summary,
        index: buildIndex(summary),
        analysisDir: this.options.analysisDir,
      };
      this.cached = loaded;
      this.cacheKey = key;
      this.log(`loaded summary (${summary.files.length} files, analyzed ${summary.analyzedAt})`);
      return loaded;
    })();
    this.loading = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.loading?.key === key) this.loading = null;
    }
  }

  /**
   * Produce the first analysis for a project that has none, and return its
   * stat. Another process may be mid-analysis (the editor, a CLI run, a second
   * MCP client) — in that case we wait for its summary rather than starting a
   * competing scan.
   */
  private async coldStart() {
    if (!this.allowColdStart) {
      throw new MissingAnalysisError(
        `No analysis found at ${this.summaryPath}. This server is read-only ` +
          `(--no-auto-analyze --no-cold-start). Analyze from VS Code ` +
          `(ClarifyDoc: Analyze Workspace) or run ` +
          `\`clarifydoc analyze ${this.options.projectRoot}\`.`,
      );
    }

    const holder = await currentLockHolder(this.options.analysisDir);
    if (holder) return this.awaitOtherRun(holder);

    const refusal = this.options.coldStartRefusal ?? unsafeColdStartRoot(this.options.projectRoot);
    if (refusal) {
      throw new MissingAnalysisError(
        `Not analyzing automatically: ${refusal}. Start the server with the project's path ` +
          `(\`clarifydoc mcp <path>\`), or analyze it first (\`clarifydoc analyze <path>\`).`,
      );
    }

    this.log("no analysis on disk — running one now");
    try {
      await this.runAnalysis({ full: false });
    } catch (err) {
      // Lost the race between the check above and the lock: wait it out.
      if (err instanceof AnalysisLockedError) return this.awaitOtherRun(err.owner);
      throw err;
    }
    const info = await statOrNull(this.summaryPath);
    if (!info) throw new MissingAnalysisError(`Analysis did not produce ${this.summaryPath}.`);
    return info;
  }

  /** Wait for the summary another process is writing, up to COLD_START_WAIT_MS. */
  private async awaitOtherRun(owner: LockOwner | null) {
    const who = owner ? `pid ${owner.pid}` : "another process";
    this.log(`${who} is analyzing ${this.options.analysisDir} — waiting for it`);
    const arrived = await waitFor(async () => (await statOrNull(this.summaryPath)) !== null, COLD_START_WAIT_MS);
    const info = arrived ? await statOrNull(this.summaryPath) : null;
    if (!info) {
      throw new MissingAnalysisError(
        `An analysis started by ${who} is still running after ` +
          `${Math.round(COLD_START_WAIT_MS / 1000)}s and ${this.summaryPath} does not exist yet. ` +
          `Retry shortly.`,
      );
    }
    return info;
  }

  /** Run (or re-run) the analysis. Concurrent callers share one run. */
  async refresh(opts: { full?: boolean } = {}): Promise<AnalyzeResult> {
    if (!this.allowAnalyze) {
      throw new MissingAnalysisError(
        "This server was started read-only (--no-auto-analyze); run the analysis from the CLI or VS Code instead.",
      );
    }
    return this.runAnalysis(opts);
  }

  /** The analysis run itself, without the read-only guard. */
  private async runAnalysis(opts: { full?: boolean } = {}): Promise<AnalyzeResult> {
    if (this.running) {
      this.log("analysis already running — awaiting it");
      return this.running;
    }
    const settings = this.options.analyzeSettings ?? {};
    const run = withStdoutProtected(this.log, () =>
      analyze({
        projectRoot: this.options.projectRoot,
        outputDir: this.options.analysisDir,
        incremental: opts.full ? false : settings.incremental !== false,
        lsp: settings.lsp === true,
        lspTimeout: settings.lspTimeout,
        gitHistory: settings.gitHistory !== false,
        include: settings.include,
        exclude: settings.exclude,
        maxFiles: settings.maxFiles,
        pretty: false,
        verbose: false,
      }),
    );
    this.running = run;
    try {
      const started = Date.now();
      const result = await run;
      this.log(`analysis complete: ${result.fileCount} files in ${Date.now() - started}ms`);
      // Force a reload on the next `load()`.
      this.cached = null;
      this.cacheKey = "";
      this.loading = null;
      return result;
    } finally {
      this.running = null;
    }
  }

  /**
   * The per-file JSON the analyzer wrote (imports/exports, data sources, raw
   * function list) — detail the project summary does not carry. Null when the
   * file was not analyzed or its artifact is missing.
   */
  async fileAnalysis(relativePath: string): Promise<FileAnalysis | null> {
    const target = resolve(this.options.analysisDir, `${relativePath}.json`);
    try {
      return JSON.parse(await readFile(target, "utf-8")) as FileAnalysis;
    } catch {
      return null;
    }
  }
}

/** Resolve a user-supplied path to a canonical project-relative file path. */
export function resolveFilePath(
  index: AnalysisIndex,
  projectRoot: string,
  query: string,
): { path?: string; candidates: string[] } {
  const normalized = normalizePath(query, projectRoot);
  if (!normalized) return { candidates: [] };

  const exact = index.pathLookup.get(normalized);
  if (exact) return { path: exact, candidates: [exact] };

  const suffix = `/${normalized}`;
  const base = normalized.split("/").pop() ?? normalized;
  const suffixHits: string[] = [];
  const baseHits: string[] = [];
  const looseHits: string[] = [];
  for (const [lower, path] of index.pathLookup) {
    if (lower.endsWith(suffix)) suffixHits.push(path);
    else if ((lower.split("/").pop() ?? "") === base) baseHits.push(path);
    else if (lower.includes(normalized)) looseHits.push(path);
  }
  // Tiers, strongest first: a unique path-suffix match wins even when weaker
  // basename matches exist elsewhere in the tree ("db/products.ts" should not
  // be blocked by an unrelated "api/products.ts"). Ambiguity is only reported
  // within the strongest tier that matched.
  for (const tier of [suffixHits, baseHits, looseHits]) {
    if (tier.length === 1) return { path: tier[0], candidates: tier };
    if (tier.length > 1) return { candidates: tier.slice(0, 12) };
  }
  return { candidates: [] };
}

/** Lowercased, forward-slashed, project-root-relative form of a path. */
export function normalizePath(input: string, projectRoot?: string): string {
  let p = input.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (projectRoot) {
    const root = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
    if (p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) p = p.slice(root.length + 1);
  }
  return p.replace(/^\/+/, "").toLowerCase();
}

function emptyFacts(path: string): FileFacts {
  return {
    path,
    routes: [],
    screens: [],
    apiCalls: [],
    security: [],
    violationsFrom: [],
    violationsTo: [],
    outbound: [],
    inbound: [],
    dataAccess: [],
    reach: [],
    duplicates: [],
    callsRoutes: [],
    servesCalls: [],
    opens: [],
    openedBy: [],
  };
}

/**
 * One pass over the summary that groups everything by file, so per-file tools
 * (`clarifydoc_file`, `clarifydoc_trace`) don't re-scan multi-thousand-entry
 * arrays on every call.
 */
export function buildIndex(summary: ProjectAnalysis): AnalysisIndex {
  const byFile = new Map<string, FileFacts>();
  const pathLookup = new Map<string, string>();

  const facts = (path: string | undefined): FileFacts | null => {
    if (!path) return null;
    let f = byFile.get(path);
    if (!f) {
      f = emptyFacts(path);
      byFile.set(path, f);
      pathLookup.set(path.toLowerCase(), path);
    }
    return f;
  };

  for (const file of summary.files) facts(file);

  const layers = summary.fileLayerMap ?? {};
  for (const [path, layer] of Object.entries(layers)) {
    const f = facts(path);
    if (f) f.layer = layer;
  }
  for (const [path, projectId] of Object.entries(summary.fileProjects ?? {})) {
    const f = facts(path);
    if (f) f.projectId = projectId;
  }
  for (const route of (summary.routeMap ?? []) as RouteWithFile[]) {
    facts(route.filePath)?.routes.push(route);
  }
  for (const screen of summary.screens ?? []) {
    facts(screen.filePath)?.screens.push(screen);
  }
  for (const call of (summary.apiCalls ?? []) as ApiCallWithFile[]) {
    facts(call.filePath)?.apiCalls.push(call);
  }
  for (const c of summary.complexity ?? []) {
    const f = facts(c.filePath);
    if (f) f.complexity = c;
  }
  for (const issue of summary.securityIssues ?? []) {
    facts(issue.filePath)?.security.push(issue);
  }
  for (const v of summary.layerViolations ?? []) {
    facts(v.sourceFile)?.violationsFrom.push(v);
    facts(v.targetFile)?.violationsTo.push(v);
  }
  for (const link of summary.symbolLinks ?? []) {
    facts(link.sourceFile)?.outbound.push(link);
    facts(link.targetFile)?.inbound.push(link);
  }
  for (const access of summary.symbolDataAccess ?? []) {
    facts(access.file)?.dataAccess.push(access);
  }
  const reachBySymbol = new Map<string, SymbolReachSummary>();
  for (const reach of summary.symbolReach ?? []) {
    facts(reach.file)?.reach.push(reach);
    reachBySymbol.set(symbolKey(reach.file, reach.symbol), reach);
  }
  for (const blast of summary.blastRadius ?? []) {
    const f = facts(blast.filePath);
    if (f) f.blast = blast;
  }
  for (const churn of summary.fileChurn ?? []) {
    const f = facts(churn.file);
    if (f) f.churn = churn;
  }
  for (const profile of summary.responsibilityProfiles ?? []) {
    const f = facts(profile.filePath);
    if (f) f.responsibility = profile;
  }
  for (const p of summary.refactorPressure ?? []) {
    const f = facts(p.filePath);
    if (f) f.pressure = p;
  }
  for (const group of summary.duplicates ?? []) {
    for (const occurrence of group.occurrences) {
      facts(occurrence.filePath)?.duplicates.push(group);
    }
  }
  for (const link of summary.apiRouteLinks ?? []) {
    facts(link.source)?.callsRoutes.push(link);
    facts(link.target)?.servesCalls.push(link);
  }
  for (const launch of summary.componentLaunches ?? []) {
    facts(launch.sourceFile)?.opens.push(launch);
    facts(launch.targetFile)?.openedBy.push(launch);
  }

  const entitiesByName = new Map<string, EntityGraphNode[]>();
  for (const node of summary.entityGraph?.nodes ?? []) {
    const key = node.name.toLowerCase();
    const list = entitiesByName.get(key);
    if (list) list.push(node);
    else entitiesByName.set(key, [node]);
  }

  return { byFile, pathLookup, entitiesByName, reachBySymbol };
}

export function symbolKey(file: string, symbol: string): string {
  return `${file.toLowerCase()}::${symbol.toLowerCase()}`;
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * Run a task with everything that would reach stdout diverted away from it.
 *
 * On an MCP session stdout carries the JSON-RPC stream, and one stray byte
 * corrupts the frame it lands in. The analyzer is a CLI tool: it logs through
 * `console.*` AND draws an in-place progress line with a bare
 * `process.stdout.write("\rAnalyzing …")`, so both have to be captured — the
 * progress line is transient UI and is dropped rather than logged, since it
 * ticks once per file.
 */
export async function withStdoutProtected<T>(
  log: (message: string) => void,
  task: () => Promise<T>,
): Promise<T> {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
    // Saved unbound: restoring the exact property value keeps nesting (and
    // identity checks) honest instead of layering a bound copy each time.
    write: process.stdout.write,
  };
  const divert =
    (level: string) =>
    (...args: unknown[]) =>
      log(`[${level}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
  console.log = divert("log");
  console.info = divert("info");
  console.warn = divert("warn");
  console.debug = divert("debug");
  process.stdout.write = ((
    _chunk: unknown,
    encoding?: unknown,
    callback?: unknown,
  ): boolean => {
    // Honour whichever of the two optional-argument shapes the caller used.
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as typeof process.stdout.write;
  try {
    return await task();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.debug = original.debug;
    process.stdout.write = original.write;
  }
}
