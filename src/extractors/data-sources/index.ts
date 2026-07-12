import type { Tree } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../types/analysis.js";
import type { DataSourceExtractor as DataSourceExtractorType } from "./base.js";
import { pluginFor } from "../registry.js";

/**
 * Extract data sources from an AST.
 * Identifies: API calls, state hooks, context usage, store reads, env vars.
 * Delegates to the language plugin's extractor (`meta.dataSources`).
 */
export function extractDataSources(
  tree: Tree,
  sourceText: string,
  language: Language,
): DataSourceInfo[] {
  const extractor = pluginFor(language)?.dataSources;
  if (!extractor) return [];
  return extractor.extract(tree, sourceText);
}

/** The registered extractor for a language, if any (for fused walks). */
export function dataSourceExtractorFor(language: Language): DataSourceExtractorType | undefined {
  return pluginFor(language)?.dataSources;
}

export { DataSourceExtractor } from "./base.js";
