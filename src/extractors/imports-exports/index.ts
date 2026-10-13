import type { Tree } from "web-tree-sitter";
import type { ImportInfo, ExportInfo, Language } from "../../types/analysis.js";
import { pluginFor } from "../registry.js";

/**
 * Extract imports from an AST.
 * Delegates to the language plugin's extractor (`meta.importsExports`).
 */
export function extractImports(
  tree: Tree,
  sourceText: string,
  language: Language,
): ImportInfo[] {
  const extractor = pluginFor(language)?.importsExports;
  if (!extractor) return [];
  return extractor.extractImports(tree, sourceText);
}

/**
 * Extract exports from an AST.
 */
export function extractExports(
  tree: Tree,
  sourceText: string,
  language: Language,
  filePath?: string,
): ExportInfo[] {
  const extractor = pluginFor(language)?.importsExports;
  if (!extractor) return [];
  return extractor.extractExports(tree, sourceText, filePath);
}

export { ImportExportExtractor } from "./base.js";
