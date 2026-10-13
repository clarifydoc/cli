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
import { McpServer, serveStdio, type McpPrompt, type McpResource, type McpResourceTemplate, type McpTool } from "./protocol.js";
import { TOOL_VERSION } from "../core/version.js";
import { AnalysisStore, type AnalyzeSettings } from "./store.js";
import { statusReport, type ToolContext } from "./tools/context.js";
import { analyzeTool, healthTool, impactTool, searchTool, servicesTool, statusTool } from "./tools/overview.js";
import { blastRadiusTool, contractTool, fileTool, routesTool, screensTool, traceTool } from "./tools/code.js";
import { extractTool } from "./tools/extract.js";
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
  /** When false the server never re-analyzes on request (it still cold-starts). */
  allowAnalyze?: boolean;
  /** When false the server will not even run the first analysis for a project with none. */
  allowColdStart?: boolean;
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
   which screen calls which endpoint, and which table that endpoint writes. Routes carry who may call them
   (policy, roles, scheme, or anonymous), which API versions they serve, and each parameter's binding; filter by
   those, and use clarifydoc_contract for one endpoint's full request shape before calling it.
   clarifydoc_services lifts the same links to sub-projects: which frontend, service or worker calls which.
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
    allowColdStart: config.allowColdStart,
    analyzeSettings: config.analyzeSettings,
    log,
  });
  const ctx: ToolContext = { store };

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

  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: config.version ?? TOOL_VERSION,
    instructions: INSTRUCTIONS,
    tools,
    resources,
    resourceTemplates,
    prompts: WORKFLOW_PROMPTS,
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

/**
 * Workflows a client can offer by name: each fills in the order of tool calls
 * that answers one recurring question, so the model does not have to discover
 * it from the tool descriptions.
 */
const WORKFLOW_PROMPTS: McpPrompt[] = [
  {
    name: "before-editing",
    title: "Before editing a file",
    description: "What to know before changing a file (and optionally one function in it): what it is, who depends on it, what breaks.",
    arguments: [
      { name: "file", description: "Project-relative path of the file to change.", required: true },
      { name: "symbol", description: "The function or method to change, if one." },
    ],
    render: ({ file, symbol }) => [
      `I am about to change \`${file}\`${symbol ? ` — specifically \`${symbol}\`` : ""}. Using the ClarifyDoc tools, in this order:`,
      `1. clarifydoc_file path="${file}" — what the file declares, its routes/screens/data access and its layer.`,
      `2. clarifydoc_blast_radius path="${file}" — what kind of file it is, who depends on it, and the screens and routes whose execution passes through it.`,
      ...(symbol ? [
        `3. clarifydoc_extract symbol="${symbol}" file="${file}" — its source and the functions it calls.`,
        `4. clarifydoc_trace symbol="${symbol}" file="${file}" direction="callers" — who calls it, with file:line.`,
      ] : []),
      `${symbol ? 5 : 3}. clarifydoc_impact files=["${file}"] — the tests to run and the risk level.`,
      "Then summarize: what the change can break, which callers must be checked, and which tests to run.",
    ].join("\n"),
  },
  {
    name: "trace-feature",
    title: "Trace a feature end to end",
    description: "Follow one feature from the screen through the API to the data it reads and writes.",
    arguments: [{ name: "feature", description: "A word for the feature: a screen, an endpoint, an entity (e.g. \"checkout\").", required: true }],
    render: ({ feature }) => [
      `Trace the "${feature}" feature end to end with the ClarifyDoc tools:`,
      `1. clarifydoc_search query="${feature}" — the screens, routes, symbols and entities it names.`,
      `2. clarifydoc_screens / clarifydoc_routes path="${feature}" — the entry points, the API calls a screen makes and the frontend files that call a route.`,
      `3. clarifydoc_data_flows — which of those entry points reach which tables and queues, with the call path (via).`,
      `4. clarifydoc_trace symbol=<the handler> to=<the repository or service method> — the exact call path, hop by hop, where one is unclear.`,
      "Then describe the flow as: screen → API call → route handler → services → data, naming file:line at each step and flagging any hop marked inferred or ambiguous.",
    ].join("\n"),
  },
  {
    name: "endpoint-gaps",
    title: "Find broken or unused endpoints",
    description: "Frontend calls that reach no backend route, and routes nothing in the repository calls.",
    arguments: [{ name: "path", description: "Narrow to URLs/routes containing this (optional)." }],
    render: ({ path }) => [
      `Use clarifydoc_routes gaps=true${path ? ` path="${path}"` : ""} to list the calls that reach no route and the routes no call reaches.`,
      "For each call that reaches no route, check whether the backend renamed or removed the endpoint (clarifydoc_routes path=<a segment of the URL>) and say which.",
      "For uncalled routes, remember an endpoint may be called from outside the repository; only call one dead when nothing in the repository and no external client plausibly uses it.",
    ].join("\n"),
  },
];
