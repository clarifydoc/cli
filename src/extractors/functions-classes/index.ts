import type { Tree } from "web-tree-sitter";
import type { FunctionInfo, ClassInfo, Language } from "../../types/analysis.js";
import { pluginFor } from "../registry.js";

/**
 * Extract top-level functions from an AST.
 * Delegates to the language plugin's extractor (`meta.functionsClasses`).
 */
export function extractFunctions(
  tree: Tree,
  sourceText: string,
  language: Language,
): FunctionInfo[] {
  const extractor = pluginFor(language)?.functionsClasses;
  if (!extractor) return [];
  return extractor.extractFunctions(tree, sourceText);
}

/**
 * Extract classes/interfaces from an AST.
 */
export function extractClasses(
  tree: Tree,
  sourceText: string,
  language: Language,
): ClassInfo[] {
  const extractor = pluginFor(language)?.functionsClasses;
  if (!extractor) return [];
  return extractor.extractClasses(tree, sourceText);
}

export { FunctionClassExtractor } from "./base.js";
