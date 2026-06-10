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
// PHP is parsed via tree-sitter; phpSpec is still imported by language-map for
// the `.php` extension registration and acts as the regex fallback path.
import { swiftSpec } from "../extractors/plugins/swift/index.js";
import { luaSpec } from "../extractors/plugins/lua/index.js";
import { scalaSpec } from "../extractors/plugins/scala/index.js";
import { perlSpec } from "../extractors/plugins/perl/index.js";
import { vbSpec } from "../extractors/plugins/vb/index.js";
import { sqlSpec, fixSqlFunctionEndLines } from "../extractors/plugins/sql/index.js";
import { cSpec } from "../extractors/plugins/c/index.js";
import { cppSpec } from "../extractors/plugins/cpp/index.js";

/** Registry of language specs keyed by Language. */
const SPECS: Partial<Record<Language, RegexLangSpec>> = Object.fromEntries(
  [goSpec, rustSpec, rubySpec, swiftSpec, luaSpec, scalaSpec, perlSpec, vbSpec, sqlSpec, cSpec, cppSpec]
    .map((s) => [s.language, s]),
);

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

  // SQL routines (PROCEDURE/FUNCTION/TRIGGER) need BEGIN/END-aware end-line patching
  // so blast-radius and complexity see the right body range.
  if (language === "sql") {
    analysis.functions = fixSqlFunctionEndLines(lines, analysis.functions);
  }

  return analysis;
}
