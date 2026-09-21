export { analyze, type AnalyzeOptions, type AnalyzeResult } from "./core/analyzer.js";
// Plugin bodies load lazily; `analyze`/`analyzeFile` self-activate, but API
// consumers driving extraction paths directly can pre-load here.
export { ensureLanguagesLoaded, loadAllPlugins } from "./extractors/registry.js";
export { discoverFiles } from "./core/file-discovery.js";
export { gatherProjectInfo, detectFrameworks } from "./core/framework-detector.js";
export { parseSource, parseFile, runQuery } from "./parsers/parser-manager.js";
export { parseDfm } from "./parsers/dfm-parser.js";
export type { TSTree, TSNode, TSLanguage } from "./parsers/parser-manager.js";
export { generateHtmlReport, type ReportOptions } from "./core/html-report.js";
export {
  buildReportPayload,
  loadReportSummary,
  loadReportPayload,
  type ReportPayload,
} from "./core/report-payload.js";
export { detectDeployment, parseSimpleYaml } from "./core/deployment.js";
export {
  normalizeProject,
  denormalizeProject,
  isNormalized,
  type ElementInfo,
  type ElementId,
  type NormalizedProjectAnalysis,
} from "./core/element-registry.js";
export { computeComplexity, aggregateComplexity } from "./core/complexity-analyzer.js";
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
  type SetScore,
  type RankResult,
  type TokenScore,
} from "./eval/scorer.js";
export type * from "./types/analysis.js";
export type * from "./types/plugin.js";
export type * from "./types/language-plugin.js";
