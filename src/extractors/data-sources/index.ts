import type { Tree } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../types/analysis.js";
import type { DataSourceExtractor } from "./base.js";
import { JavaScriptDataSourceExtractor } from "../plugins/javascript/data-sources.js";
import { PythonDataSourceExtractor } from "../plugins/python/data-sources.js";
import { JavaKotlinDataSourceExtractor } from "../plugins/java-kotlin/data-sources.js";
import { PascalDataSourceExtractor } from "../plugins/pascal/data-sources.js";
import { CSharpDataSourceExtractor } from "../plugins/csharp/data-sources.js";
import { PhpDataSourceExtractor } from "../plugins/php/data-sources.js";

/** All registered language extractors */
const extractors: DataSourceExtractor[] = [
  new JavaScriptDataSourceExtractor(),
  new PythonDataSourceExtractor(),
  new JavaKotlinDataSourceExtractor(),
  new PascalDataSourceExtractor(),
  new CSharpDataSourceExtractor(),
  new PhpDataSourceExtractor(),
];

/** Language → extractor lookup (built once at import time) */
const extractorMap = new Map<Language, DataSourceExtractor>();
for (const ext of extractors) {
  for (const lang of ext.languages) {
    extractorMap.set(lang, ext);
  }
}

/**
 * Extract data sources from an AST.
 * Identifies: API calls, state hooks, context usage, store reads, env vars.
 */
export function extractDataSources(
  tree: Tree,
  sourceText: string,
  language: Language,
): DataSourceInfo[] {
  const extractor = extractorMap.get(language);
  if (!extractor) return [];
  return extractor.extract(tree, sourceText);
}

/** The registered extractor for a language, if any (for fused walks). */
export function dataSourceExtractorFor(language: Language): DataSourceExtractor | undefined {
  return extractorMap.get(language);
}

/** Register a custom extractor at runtime */
export function registerDataSourceExtractor(extractor: DataSourceExtractor): void {
  extractors.push(extractor);
  for (const lang of extractor.languages) {
    extractorMap.set(lang, extractor);
  }
}

export { DataSourceExtractor } from "./base.js";
