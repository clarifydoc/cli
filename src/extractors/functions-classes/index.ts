import type { Tree } from "web-tree-sitter";
import type { FunctionInfo, ClassInfo, Language } from "../../types/analysis.js";
import type { FunctionClassExtractor } from "./base.js";
import { JavaScriptExtractor } from "../plugins/javascript/functions-classes.js";
import { PythonExtractor } from "../plugins/python/functions-classes.js";
import { CSharpExtractor } from "../plugins/csharp/functions-classes.js";
import { PascalExtractor } from "../plugins/pascal/functions-classes.js";
import { JavaKotlinExtractor } from "../plugins/java-kotlin/functions-classes.js";
import { PhpExtractor } from "../plugins/php/functions-classes.js";

/** All registered language extractors */
const extractors: FunctionClassExtractor[] = [
  new JavaScriptExtractor(),
  new PythonExtractor(),
  new CSharpExtractor(),
  new PascalExtractor(),
  new JavaKotlinExtractor(),
  new PhpExtractor(),
];

/** Language → extractor lookup (built once at import time) */
const extractorMap = new Map<Language, FunctionClassExtractor>();
for (const ext of extractors) {
  for (const lang of ext.languages) {
    extractorMap.set(lang, ext);
  }
}

/**
 * Extract top-level functions from an AST.
 */
export function extractFunctions(
  tree: Tree,
  sourceText: string,
  language: Language,
): FunctionInfo[] {
  const extractor = extractorMap.get(language);
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
  const extractor = extractorMap.get(language);
  if (!extractor) return [];
  return extractor.extractClasses(tree, sourceText);
}

/** Register a custom extractor at runtime */
export function registerFunctionClassExtractor(extractor: FunctionClassExtractor): void {
  extractors.push(extractor);
  for (const lang of extractor.languages) {
    extractorMap.set(lang, extractor);
  }
}

export { FunctionClassExtractor } from "./base.js";
