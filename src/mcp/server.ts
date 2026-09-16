/**
 * The ClarifyDoc MCP server: an analysis store plus the tool set that reads it.
 *
 * Two entry points use this:
 *   • `clarifydoc mcp` (src/cli.ts) — any MCP client (Claude Code, Cursor, …);
 *   • the VS Code extension, which registers the same command as an MCP server
 *     definition pointed at its private per-workspace analysis directory, so
 *     Copilot's agent mode gets the tools with no configuration at all.
 */

import { basename, dirname, join, resolve } from "path";
import { existsSync } from "fs";
import { McpServer, serveStdio, type McpResource, type McpTool } from "./protocol.js";
import { AnalysisStore, type AnalyzeSettings } from "./store.js";
import { statusReport, type ToolContext } from "./tools/context.js";
import { analyzeTool, healthTool, impactTool, searchTool, statusTool } from "./tools/overview.js";
import { blastRadiusTool, fileTool, routesTool, screensTool, traceTool } from "./tools/code.js";
import { dataFlowsTool, dataModelTool } from "./tools/data.js";

export const MCP_SERVER_NAME = "clarifydoc";

export interface McpServerConfig {
  /** Project to serve. Defaults to the process cwd. */
  projectRoot?: string;
  /**
   * Directory holding project-summary.json. Defaults to
   * `<projectRoot>/.clarifydoc/<projectName>` — where `clarifydoc analyze` and
   * the VS Code extension both write, so a client that passes nothing but a cwd
   * finds the analysis.
   */
  analysisDir?: string;
  /** Base output dir, as passed to `analyze -o`; `<base>/<projectName>` is used. */
  outputBase?: string;
  /** When false the server only reads existing analyses (never scans). */
  allowAnalyze?: boolean;
  analyzeSettings?: AnalyzeSettings;
  /** Reported in `serverInfo.version`. */
  version?: string;
  log?: (message: string) => void;
}

/**
 * Markers that identify a project root when a client launches the server with
 * nothing but a working directory.
 */
const ROOT_MARKERS = [
  ".git",
  ".clarifydoc",
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "requirements.txt",
  "pyproject.toml",
  "composer.json",
  "Gemfile",
];

/**
 * The project root to serve when the client passed no path: the nearest
 * ancestor of `startDir` that looks like a project.
 *
 * Agents launch a stdio server with their workspace as the working directory,
 * but not always — a subdirectory is common, and analyzing that would map a
 * fraction of the project. Walking up to a marker makes an argument-free
 * config ("command": "clarifydoc-mcp") do the right thing from anywhere inside
 * the project. Falls back to `startDir` when nothing matches.
 */
export function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

/** Where an analysis for `projectRoot` lives, given a base output dir. */
export function defaultAnalysisDir(projectRoot: string, outputBase = ".clarifydoc"): string {
  const root = resolve(projectRoot);
  return resolve(root, outputBase, basename(root));
}

const INSTRUCTIONS = `ClarifyDoc maps this codebase from its source — frontend route to API endpoint to database
table — with static analysis (tree-sitter/regex), not guesses. Use it to orient in unfamiliar code and to check
what a change touches, instead of grepping around.

Suggested order:
1. clarifydoc_status — what has been mapped, and how stale it is.
2. clarifydoc_search — find a route, screen, symbol, table or file by name.
3. clarifydoc_file / clarifydoc_trace / clarifydoc_blast_radius — what a file contains, who calls it, what breaks
   if it changes.
4. clarifydoc_routes / clarifydoc_screens / clarifydoc_data_model / clarifydoc_data_flows — the cross-tier chain:
   which screen calls which endpoint, and which table that endpoint writes.
5. clarifydoc_health and clarifydoc_impact — findings, and the effect of the current git diff.

Facts are extracted, not inferred, but cross-file links can be heuristic: rows tagged \`inferred\` or \`ambiguous\`
are lower-confidence and worth verifying in the source before acting on them. Paths are project-relative, with
\`path:line\` for anything you may want to open. If results look stale after edits, call clarifydoc_analyze
(incremental, cheap).`;

export interface BuiltMcpServer {
  server: McpServer;
  store: AnalysisStore;
  tools: McpTool[];
}

/** Assemble the server without connecting a transport (also used by the tests). */
export function buildMcpServer(config: McpServerConfig = {}): BuiltMcpServer {
  const projectRoot = resolve(config.projectRoot ?? process.cwd());
  const analysisDir = config.analysisDir
    ? resolve(config.analysisDir)
    : defaultAnalysisDir(projectRoot, config.outputBase);
  const log = config.log ?? (() => {});

  const store = new AnalysisStore({
    projectRoot,
    analysisDir,
    allowAnalyze: config.allowAnalyze,
    analyzeSettings: config.analyzeSettings,
    log,
  });
  const ctx: ToolContext = { store };

  const tools: McpTool[] = [
    statusTool(ctx),
    searchTool(ctx),
    routesTool(ctx),
    screensTool(ctx),
    fileTool(ctx),
    traceTool(ctx),
    blastRadiusTool(ctx),
    dataModelTool(ctx),
    dataFlowsTool(ctx),
    healthTool(ctx),
    impactTool(ctx),
    analyzeTool(ctx),
  ];

  const resources: McpResource[] = [
    {
      uri: "clarifydoc://analysis/status",
      name: "ClarifyDoc analysis status",
      description: "What ClarifyDoc has mapped for this project (same content as clarifydoc_status).",
      mimeType: "text/markdown",
      read: async () => statusReport(await store.load(), store),
    },
  ];

  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: config.version ?? "0.1.0",
    instructions: INSTRUCTIONS,
    tools,
    resources,
    log,
  });

  return { server, store, tools };
}

/**
 * Serve MCP on stdio until the client disconnects.
 *
 * The analyzer and its plugins log freely, and stdout is the protocol wire, so
 * `console.log`/`info` are pinned to stderr for the whole session (the store
 * does the same around an analysis run, which also catches library writes).
 */
export async function startMcpServer(config: McpServerConfig = {}): Promise<void> {
  const stderrLog = (message: string) => {
    process.stderr.write(`[clarifydoc-mcp] ${message}\n`);
  };
  const log = config.log ?? stderrLog;

  const { server, store } = buildMcpServer({ ...config, log });

  // Take the only handle on the real stdout, then divert the descriptor for the
  // rest of the session: anything that writes to it by habit (console, the
  // analyzer's progress line, a chatty plugin) becomes a stderr diagnostic
  // instead of a byte in the middle of a JSON-RPC frame.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const toStderr =
    (level: string) =>
    (...args: unknown[]) =>
      log(`[${level}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
  console.log = toStderr("log");
  console.info = toStderr("info");
  console.debug = toStderr("debug");
  process.stdout.write = ((
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown,
  ): boolean => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    const cleaned = text.replace(/[\r\n]+/g, " ").trim();
    if (cleaned) log(`[stdout] ${cleaned}`);
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as typeof process.stdout.write;

  log(`serving ${store.projectRoot}`);
  log(`analysis dir ${store.analysisDir}${store.allowAnalyze ? "" : " (read-only)"}`);
  if (!(await store.exists())) {
    log(
      store.allowAnalyze
        ? "no analysis yet — the first tool call will run one"
        : "no analysis yet and analysis is disabled — tools will report that",
    );
  }

  await serveStdio(server, {
    writeLine: (line) => void stdoutWrite(line),
    onClose: () => log("client disconnected"),
  });
}
