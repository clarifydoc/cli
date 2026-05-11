import { createEmptyAnalysis, type FileAnalysis, type Language } from "../types/analysis.js";
import {
  type RegexLangSpec,
  extractFunctionsWithSpec,
  extractClassesWithSpec,
  extractImportsWithSpec,
  deriveExportsFromFnClasses,
} from "../extractors/plugins/shared/regex-base.js";
import { goSpec } from "../extractors/plugins/go/index.js";
import { rustSpec } from "../extractors/plugins/rust/index.js";
import { rubySpec } from "../extractors/plugins/ruby/index.js";
import { phpSpec } from "../extractors/plugins/php/index.js";
import { swiftSpec } from "../extractors/plugins/swift/index.js";
import { luaSpec } from "../extractors/plugins/lua/index.js";
import { scalaSpec } from "../extractors/plugins/scala/index.js";
import { perlSpec } from "../extractors/plugins/perl/index.js";
import { vbSpec } from "../extractors/plugins/vb/index.js";

/** Registry of language specs keyed by Language. */
const SPECS: Partial<Record<Language, RegexLangSpec>> = {
  go: goSpec,
  rust: rustSpec,
  ruby: rubySpec,
  php: phpSpec,
  swift: swiftSpec,
  lua: luaSpec,
  scala: scalaSpec,
  perl: perlSpec,
  vb: vbSpec,
};

/**
 * Regex-based file analysis for languages without tree-sitter support,
 * or as a fallback when tree-sitter parsing fails.
 */
export function extractWithRegex(
  sourceText: string,
  filePath: string,
  language: Language,
): FileAnalysis {
  const analysis = createEmptyAnalysis(filePath, language);
  const spec = SPECS[language];
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

  return analysis;
}
