import { createEmptyAnalysis, type FileAnalysis, type Language } from "../types/analysis.js";
import {
  extractFunctionsWithSpec,
  extractClassesWithSpec,
  extractImportsWithSpec,
  deriveExportsFromFnClasses,
} from "../extractors/plugins/shared/regex-base.js";
import { regexSpecFor } from "../extractors/registry.js";

/**
 * Regex-based file analysis for languages without tree-sitter support,
 * or as a fallback when tree-sitter parsing fails. The per-language
 * `RegexLangSpec` comes from the plugin registry (`meta.regexSpec`).
 */
export function extractWithRegex(
  sourceText: string,
  filePath: string,
  language: Language,
): FileAnalysis {
  const analysis = createEmptyAnalysis(filePath, language);
  const spec = regexSpecFor(language);
  if (!spec) return analysis;

  const lines = sourceText.split("\n");

  analysis.functions = extractFunctionsWithSpec(lines, spec);
  analysis.classes = spec.extractClasses
    ? spec.extractClasses(lines, analysis.functions)
    : extractClassesWithSpec(lines, spec);
  // When classes have methods (e.g. Perl file-scoped packages), remove those methods
  // from the top-level functions list to avoid double-counting.
  if (spec.extractClasses) {
    const methodLines = new Set<number>();
    for (const cls of analysis.classes) {
      for (const m of cls.methods) methodLines.add(m.line);
    }
    analysis.functions = analysis.functions.filter((fn) => !methodLines.has(fn.line));
  }
  analysis.imports = extractImportsWithSpec(lines, spec);
  analysis.exports = deriveExportsFromFnClasses(analysis.functions, analysis.classes);
  analysis.routes = spec.extractRoutes?.(lines, analysis.classes) ?? [];
  analysis.screens = spec.extractScreens?.(lines, filePath, analysis.classes) ?? [];
  analysis.dataSources = spec.extractDataSources?.(lines, analysis.classes) ?? [];

  if (spec.postProcessFunctions) {
    analysis.functions = spec.postProcessFunctions(lines, analysis.functions);
  }

  return analysis;
}
