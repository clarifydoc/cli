import type { Tree } from "web-tree-sitter";
import type { ImportInfo, ExportInfo, Language } from "../../types/analysis.js";
import type { ImportExportExtractor } from "./base.js";
import { JavaScriptImportExportExtractor } from "./javascript.js";
import { PythonImportExportExtractor } from "./python.js";
import { CSharpImportExportExtractor } from "./csharp.js";
import { PascalImportExportExtractor } from "./pascal.js";
import { JavaKotlinImportExportExtractor } from "./java-kotlin.js";

/** All registered language extractors */
const extractors: ImportExportExtractor[] = [
  new JavaScriptImportExportExtractor(),
  new PythonImportExportExtractor(),
  new CSharpImportExportExtractor(),
  new PascalImportExportExtractor(),
  new JavaKotlinImportExportExtractor(),
];

/** Language → extractor lookup (built once at import time) */
const extractorMap = new Map<Language, ImportExportExtractor>();
for (const ext of extractors) {
  for (const lang of ext.languages) {
    extractorMap.set(lang, ext);
  }
}

/**
 * Extract imports from an AST.
 */
export function extractImports(
  tree: Tree,
  sourceText: string,
  language: Language,
): ImportInfo[] {
  const extractor = extractorMap.get(language);
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
): ExportInfo[] {
  const extractor = extractorMap.get(language);
  if (!extractor) return [];
  return extractor.extractExports(tree, sourceText);
}

/** Register a custom extractor at runtime */
export function registerImportExportExtractor(extractor: ImportExportExtractor): void {
  extractors.push(extractor);
  for (const lang of extractor.languages) {
    extractorMap.set(lang, extractor);
  }
}

export { ImportExportExtractor } from "./base.js";
