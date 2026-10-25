/**
 * The ClarifyDoc MCP server: an analysis store plus the tool set that reads it.
 *
 * Two entry points use this:
 *   • `clarifydoc mcp` (src/cli.ts) — any MCP client (Claude Code, Cursor, …);
 *   • the VS Code extension, which registers the same command as an MCP server
 *     definition pointed at its private per-workspace analysis directory, so
 *     Copilot's agent mode gets the tools with no configuration at all.
 */

import { controlFlowTool } from "./tools/flow.js";
import { architectureTool } from "./tools/architecture.js";
import { basename, dirname, join, resolve } from "path";
import { appendFileSync, existsSync } from "fs";
import { McpServer, serveStdio, type McpResource, type McpResourceTemplate, type McpTool } from "./protocol.js";
import { TOOL_VERSION } from "../core/version.js";
import { AnalysisStore, type AnalyzeSettings } from "./store.js";
import { freshnessBanner, statusReport, type ToolContext } from "./tools/context.js";
import { analyzeTool, healthTool, impactTool, searchTool, servicesTool, statusTool } from "./tools/overview.js";
import { blastRadiusTool, contractTool, fileTool, routesTool, screensTool, traceTool } from "./tools/code.js";
import { extractTool } from "./tools/extract.js";
import { dataFlowsTool, dataModelTool } from "./tools/data.js";
import { INSTRUCTIONS } from "./guidance.js";
import { revisionOf } from "./paging.js";
import { renderUsage, usageLine } from "./usage.js";
import { WORKFLOW_PROMPTS } from "./prompts.js";
import { explainTool } from "./tools/explain.js";
import { contextDocsTool } from "./tools/decisions.js";

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
  /** When false the server never re-analyzes on request (it still cold-starts). */
  allowAnalyze?: boolean;
  /** When false the server will not even run the first analysis for a project with none. */
  allowColdStart?: boolean;
  /**
   * Why the first analysis must not run here, when the caller knows — e.g. the
   * root was a fallback, not a project. See `AnalysisStoreOptions.coldStartRefusal`.
   */
  coldStartRefusal?: string;
  analyzeSettings?: AnalyzeSettings;
  /** Reported in `serverInfo.version`. */
  version?: string;
  log?: (message: string) => void;
  /**
   * Which tools `tools/list` offers: `all` (the default), `core` ({@link CORE_TOOLS})
   * or tool names, comma-separated, with or without the `clarifydoc_` prefix.
   * Fewer tools cost a session less up front; the rest are not callable.
   */
  tools?: string;
}

/** The `core` profile: orient, find, explain, follow, read, judge an edit, re-run. */
export const CORE_TOOLS = [
  "clarifydoc_status",
  "clarifydoc_search",
  "clarifydoc_explain",
  "clarifydoc_trace",
  "clarifydoc_file",
  "clarifydoc_extract",
  "clarifydoc_impact",
  "clarifydoc_analyze",
] as const;

/** The tools a profile keeps, in the server's own order; throws on a name no tool has. */
export function selectTools<T extends { name: string }>(tools: T[], profile: string | undefined): T[] {
  const spec = (profile ?? "all").trim();
  if (!spec || spec === "all") return tools;
  const names = spec === "core" ? [...CORE_TOOLS] : spec.split(",").map((n) => n.trim()).filter(Boolean).map((n) => (n.startsWith("clarifydoc_") ? n : `clarifydoc_${n}`));
  const unknown = names.filter((n) => !tools.some((t) => t.name === n));
  if (unknown.length) {
    throw new Error(`Unknown tool${unknown.length === 1 ? "" : "s"} for --tools: ${unknown.join(", ")}. Known: core, all, or ${tools.map((t) => t.name.replace(/^clarifydoc_/, "")).join(", ")}.`);
  }
  return tools.filter((t) => names.includes(t.name));
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
  return locateProjectRoot(startDir).root;
}

/** `findProjectRoot`, also saying whether a marker was found or `root` is the fallback. */
export function locateProjectRoot(startDir: string): { root: string; marked: boolean } {
  let dir = resolve(startDir);
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return { root: dir, marked: true };
    const parent = dirname(dir);
    if (parent === dir) return { root: resolve(startDir), marked: false };
    dir = parent;
  }
}

/** Where an analysis for `projectRoot` lives, given a base output dir. */
export function defaultAnalysisDir(projectRoot: string, outputBase = ".clarifydoc"): string {
  const root = resolve(projectRoot);
  return resolve(root, outputBase, basename(root));
}


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
    allowColdStart: config.allowColdStart,
    coldStartRefusal: config.coldStartRefusal,
    analyzeSettings: config.analyzeSettings,
    log,
  });
  const ctx: ToolContext = { store };
  const banner = freshnessBanner(store);

  const tools: McpTool[] = [
    statusTool(ctx),
    searchTool(ctx),
    routesTool(ctx),
    contractTool(ctx),
    servicesTool(ctx),
    screensTool(ctx),
    fileTool(ctx),
    traceTool(ctx),
    extractTool(ctx),
    blastRadiusTool(ctx),
    dataModelTool(ctx),
    dataFlowsTool(ctx),
    healthTool(ctx),
    architectureTool(ctx),
    contextDocsTool(ctx),
    impactTool(ctx),
    controlFlowTool(ctx),
    analyzeTool(ctx),
  ];
  // Composed from the tools above, so it says nothing they would not.
  tools.push(explainTool(ctx, tools));
  const listed = selectTools(tools, config.tools);
  // Read when asked, after the server below exists.
  let server: McpServer | undefined;

  const resources: McpResource[] = [
    {
      uri: "clarifydoc://analysis/status",
      name: "ClarifyDoc analysis status",
      description: "What ClarifyDoc has mapped for this project (same content as clarifydoc_status).",
      mimeType: "text/markdown",
      read: async () => statusReport(await store.load(), store),
    },
    {
      uri: "clarifydoc://session/usage",
      name: "ClarifyDoc session usage",
      description: "The tool calls of this session in order: answer sizes, times, failures and misses.",
      mimeType: "text/markdown",
      read: async () => renderUsage([...(server?.usage() ?? [])]),
    },
  ];

  // Templates answer with the tool that already says it: a file's facts, a
  // symbol's source with its callees.
  const toolText = async (name: string, args: Record<string, unknown>): Promise<string | null> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return null;
    try {
      return (await tool.handler(args)).text;
    } catch {
      return null;
    }
  };
  const resourceTemplates: McpResourceTemplate[] = [
    {
      uriTemplate: "clarifydoc://file/{path}",
      name: "File facts",
      description: "What ClarifyDoc knows about one file (same content as clarifydoc_file).",
      mimeType: "text/markdown",
      read: ({ path }) => toolText("clarifydoc_file", { path }),
    },
    {
      uriTemplate: "clarifydoc://symbol/{symbol}/{path}",
      name: "Symbol source",
      description: "A function's source and the functions it calls (same content as clarifydoc_extract).",
      mimeType: "text/markdown",
      read: ({ symbol, path }) => toolText("clarifydoc_extract", { symbol, file: path }),
    },
  ];

  server = new McpServer({
    name: MCP_SERVER_NAME,
    version: config.version ?? TOOL_VERSION,
    instructions:
      listed.length < tools.length
        ? `${INSTRUCTIONS}\n\nThis server was started with a narrower tool set: ${listed.map((t) => t.name).join(", ")}. The other tools named above are not available in this session.`
        : INSTRUCTIONS,
    tools: listed,
    resources,
    resourceTemplates,
    prompts: WORKFLOW_PROMPTS,
    log,
    // Every answer says when the analysis no longer describes the source —
    // except the two that are about exactly that.
    annotate: async (tool) => (tool === "clarifydoc_status" || tool === "clarifydoc_analyze" ? null : banner()),
    revision: async () => ((await store.exists()) ? revisionOf((await store.load()).summary.analyzedAt) : null),
  });

  return { server, store, tools: listed };
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
    onClose: () => {
      const session = usageLine([...server.usage()]);
      log(`client disconnected — session: ${session}`);
      const file = process.env.CLARIFYDOC_MCP_LOG;
      if (file) {
        try {
          appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), session }) + "\n");
        } catch {
          // Logging must never fail the shutdown.
        }
      }
    },
  });
}

