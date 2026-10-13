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
// The per-file index the MCP server answers from, so another consumer of a
// stored analysis groups the same facts by file the same way.
export { buildIndex, type AnalysisIndex, type FileFacts } from "./mcp/store.js";
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
export { detectPatterns } from "./core/pattern-detector.js";
export { detectDuplicates } from "./core/duplication-detector.js";
export { classifyFileLayers, detectLayerViolations } from "./core/layer-analyzer.js";
export { analyzeBlastRadius } from "./core/blast-radius.js";
export { computeHealthScore } from "./core/health-scorer.js";
export { generateSuggestions } from "./core/suggestions-engine.js";
/**
 * Scoring math for the accuracy eval (`eval/`). Exported so the harness scripts
 * can import it from the built bundle and so it is typechecked and unit-tested
 * by the same gate as everything else — see src/eval/scorer.ts.
 */
export {
  scoreSet,
  rankOf,
  meanReciprocalRank,
  scoreTokens,
  estimateTokens,
  mean,
  poolSetScores,
  scoreSampledLinks,
  type SetScore,
  type SampledCallLabel,
  type SampledLinkScore,
  type PredictedLink,
  type RankResult,
  type TokenScore,
} from "./eval/scorer.js";
/** Corpus-wide link and health counts, run against run — see src/eval/corpus-metrics.ts. */
export {
  computeCorpusMetrics,
  linkRecords,
  diffCorpusLinks,
  isJoinableTarget,
  startsWithHole,
  type CorpusMetrics,
  type CorpusSummary,
  type LinkRecord,
  type LinkDiff,
} from "./eval/corpus-metrics.js";
export type * from "./types/analysis.js";
export type * from "./types/plugin.js";
export type * from "./types/language-plugin.js";
