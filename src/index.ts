export { analyze, type AnalyzeOptions, type AnalyzeResult } from "./core/analyzer.js";
// Plugin bodies load lazily; `analyze`/`analyzeFile` self-activate, but API
// consumers driving extraction paths directly can pre-load here.
export { ensureLanguagesLoaded, loadAllPlugins } from "./extractors/registry.js";
export { discoverFiles } from "./core/file-discovery.js";
export { gatherProjectInfo, detectFrameworks } from "./core/framework-detector.js";
export { parseSource, parseFile, runQuery } from "./parsers/parser-manager.js";
export { parseDfm } from "./parsers/dfm-parser.js";
export type { TSTree, TSNode, TSLanguage } from "./parsers/parser-manager.js";
export { generateHtmlReport, renderReportFromTemplate, type ReportOptions } from "./core/html-report.js";
export {
  buildReportPayload,
  loadReportSummary,
  loadReportPayload,
  type ReportPayload,
} from "./core/report-payload.js";
export { detectDeployment, parseSimpleYaml, matchServiceToProject } from "./core/deployment.js";
// The pieces the app joins separately analyzed repositories with: the same
// address book, forwarding and route join one analysis uses on itself.
export { linkApiCallsToRoutesDetailed, normalizeRoutePath } from "./core/route-linker.js";
export { buildServiceAddresses, resolveHost, type HostResolution } from "./core/service-addresses.js";
export { matchProxyRule, forwardPath } from "./core/call-origins.js";
export { urlValue, parseAddress, isLoopbackHost } from "./core/url-values.js";
export { projectServesClosure } from "./core/project-dependencies.js";
// What the app compares a stored analysis against: one made by an older
// extractor lacks facts a newer one records (and links by).
export { EXTRACTOR_VERSION, assessFreshness, type FreshnessReport } from "./core/manifest.js";
// Projecting a set of changed files onto a stored analysis (what `impact`
// prints), for a consumer that obtains the changed set some other way.
export {
  computeImpactDiff,
  renderImpactMarkdown,
  type ImpactDiffResult,
} from "./core/impact-diff.js";
// The per-file index the MCP server answers from, so another consumer of a
// stored analysis groups the same facts by file the same way.
export { buildIndex, type AnalysisIndex, type FileFacts } from "./mcp/store.js";
// What tells an agent when to use the MCP tools, and the named workflows it
// can start from — for a host that installs the guidance or offers the
// workflows outside an MCP client.
export { AGENT_GUIDANCE } from "./mcp/guidance.js";
// The MCP server without its stdio transport — for a host that carries the
// same JSON-RPC messages over another one (an HTTP endpoint).
export { buildMcpServer, type McpServerConfig, type BuiltMcpServer } from "./mcp/server.js";
export { WORKFLOW_PROMPTS } from "./mcp/prompts.js";
export type { McpPrompt } from "./mcp/protocol.js";
export {
  normalizeProject,
  denormalizeProject,
  isNormalized,
  type ElementInfo,
  type ElementId,
  type NormalizedProjectAnalysis,
} from "./core/element-registry.js";
export { computeComplexity, aggregateComplexity } from "./core/complexity-analyzer.js";
export {
  buildControlFlow,
  cyclomaticFromCfg,
  undrawnStructure,
  type FunctionRef,
} from "./core/control-flow.js";
export {
  controlFlowForFile,
  controlFlowCapabilities,
  ControlFlowUnavailableError,
  type ControlFlowRequest,
  type ControlFlowFileResult,
} from "./core/control-flow-file.js";
export { buildRegexControlFlow, blankNonCode } from "./core/control-flow-regex.js";
export {
  toMermaidFlowchart,
  toMarkdown as controlFlowToMarkdown,
  type ControlFlowDiagram,
} from "./core/control-flow-mermaid.js";
export { mermaidLabel, idFactory } from "./core/mermaid-text.js";
export type * from "./types/control-flow.js";
export { scanSecurity } from "./core/security-scanner.js";
// The SARIF 2.1.0 log `analyze --sarif` writes, for a consumer that already
// holds an analysis and should not re-run one to export its findings.
export { buildSarif, type SarifLog } from "./core/sarif.js";
export { TOOL_VERSION } from "./core/version.js";
export { detectPatterns } from "./core/pattern-detector.js";
export { detectDuplicates } from "./core/duplication-detector.js";
export { classifyFileLayers, detectLayerViolations } from "./core/layer-analyzer.js";
export { analyzeBlastRadius } from "./core/blast-radius.js";
export { computeHealthScore } from "./core/health-scorer.js";
export { generateSuggestions } from "./core/suggestions-engine.js";
export type * from "./types/analysis.js";
export type * from "./types/plugin.js";
export type * from "./types/language-plugin.js";
