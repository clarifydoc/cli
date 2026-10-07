import type { Tree } from "web-tree-sitter";
import type { DataSourceInfo, FileAnalysis, Language } from "../../types/analysis.js";
import type { ProjectContext } from "../../types/project.js";
import type { DataSourceExtractor as DataSourceExtractorType, ProjectApiCall } from "./base.js";
import { allPluginMetas, pluginFor } from "../registry.js";

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

/**
 * Run every data-source extractor's project-level pass (`resolveProject`) over
 * the aggregated api-call rows. Family plugins share one extractor instance
 * across their metas, so each runs once; order follows the first language each
 * claims, which keeps output stable whatever order metas load in.
 */
export function resolveProjectApiCalls(calls: ProjectApiCall[], analyses: FileAnalysis[], ctx: ProjectContext): number {
  const extractors: DataSourceExtractorType[] = [];
  const seen = new Set<DataSourceExtractorType>();
  for (const meta of allPluginMetas()) {
    const ex = meta.dataSources;
    if (!ex?.resolveProject || seen.has(ex)) continue;
    seen.add(ex);
    extractors.push(ex);
  }
  const key = (e: DataSourceExtractorType) => e.languages[0] ?? "";
  extractors.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  let rewritten = 0;
  for (const ex of extractors) rewritten += ex.resolveProject!(calls, analyses, ctx);
  return rewritten;
}

export { DataSourceExtractor, type ProjectApiCall } from "./base.js";
