export { analyze, type AnalyzeOptions, type AnalyzeResult } from "./core/analyzer.js";
export { discoverFiles } from "./core/file-discovery.js";
export { gatherProjectInfo, detectFrameworks } from "./core/framework-detector.js";
export { parseSource, parseFile, runQuery } from "./parsers/parser-manager.js";
export { parseDfm } from "./parsers/dfm-parser.js";
export type { TSTree, TSNode, TSLanguage } from "./parsers/parser-manager.js";
export type * from "./types/analysis.js";
export type * from "./types/plugin.js";
