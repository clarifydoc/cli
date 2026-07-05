import type { Tree } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../types/analysis.js";
import type { DataMutationExtractor } from "./base.js";
import { JavaScriptMutationExtractor } from "../plugins/javascript/data-mutations.js";
import { PythonMutationExtractor } from "../plugins/python/data-mutations.js";
import { JavaKotlinMutationExtractor } from "../plugins/java-kotlin/data-mutations.js";
import { PascalMutationExtractor } from "../plugins/pascal/data-mutations.js";
import { PhpMutationExtractor } from "../plugins/php/data-mutations.js";

/** All registered language extractors */
const extractors: DataMutationExtractor[] = [
  new JavaScriptMutationExtractor(),
  new PythonMutationExtractor(),
  new JavaKotlinMutationExtractor(),
  new PascalMutationExtractor(),
  new PhpMutationExtractor(),
];

/** Language → extractor lookup (built once at import time) */
const extractorMap = new Map<Language, DataMutationExtractor>();
for (const ext of extractors) {
  for (const lang of ext.languages) {
    extractorMap.set(lang, ext);
  }
}

/**
 * Extract data mutation points from an AST.
 * Identifies: setState calls, dispatch calls, direct assignments to state.
 */
export function extractDataMutations(
  tree: Tree,
  sourceText: string,
  language: Language,
): DataMutationInfo[] {
  const extractor = extractorMap.get(language);
  if (!extractor) return [];
  return extractor.extract(tree, sourceText);
}

/** The registered extractor for a language, if any (for fused walks). */
export function dataMutationExtractorFor(language: Language): DataMutationExtractor | undefined {
  return extractorMap.get(language);
}

/** Register a custom extractor at runtime */
export function registerMutationExtractor(extractor: DataMutationExtractor): void {
  extractors.push(extractor);
  for (const lang of extractor.languages) {
    extractorMap.set(lang, extractor);
  }
}

export { DataMutationExtractor } from "./base.js";
