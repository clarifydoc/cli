import type { Tree } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../types/analysis.js";
import type { DataMutationExtractor as DataMutationExtractorType } from "./base.js";
import { pluginFor } from "../registry.js";

/**
 * Extract data mutation points from an AST.
 * Identifies: setState calls, dispatch calls, direct assignments to state.
 * Delegates to the language plugin's extractor (`meta.dataMutations`).
 */
export function extractDataMutations(
  tree: Tree,
  sourceText: string,
  language: Language,
): DataMutationInfo[] {
  const extractor = pluginFor(language)?.dataMutations;
  if (!extractor) return [];
  return extractor.extract(tree, sourceText);
}

/** The registered extractor for a language, if any (for fused walks). */
export function dataMutationExtractorFor(language: Language): DataMutationExtractorType | undefined {
  return pluginFor(language)?.dataMutations;
}

export { DataMutationExtractor } from "./base.js";
