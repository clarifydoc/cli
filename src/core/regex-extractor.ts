import { createEmptyAnalysis, type FileAnalysis, type Language } from "../types/analysis.js";
import {
  extractFunctionsWithSpec,
  extractClassesWithSpec,
  extractImportsWithSpec,
  deriveExportsFromFnClasses,
} from "../extractors/plugins/shared/regex-base.js";
import { regexSpecFor } from "../extractors/registry.js";
import { extractEntities, mergeEntities } from "../extractors/entities/index.js";
import { isTestFile } from "./test-file-detector.js";

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
  // Test files (unit/integration/e2e specs) never expose real routes.
  analysis.routes = isTestFile(filePath, language)
    ? []
    : spec.extractRoutes?.(lines, analysis.classes, filePath) ?? [];
  analysis.screens = spec.extractScreens?.(lines, filePath, analysis.classes) ?? [];
  // UI markup files (Blazor .razor) contribute component usage + interactive
  // elements the same way Vue/React do via AST hooks — the screen builder's flat
  // fallback turns these into a screen tree.
  if (spec.extractSubComponents) analysis.subComponents = spec.extractSubComponents(lines);
  if (spec.extractInteractiveElements) analysis.interactiveElements = spec.extractInteractiveElements(lines);
  analysis.dataSources = spec.extractDataSources?.(lines, analysis.classes) ?? [];

  if (spec.postProcessFunctions) {
    analysis.functions = spec.postProcessFunctions(lines, analysis.functions);
  }
  if (spec.postProcessClasses) {
    analysis.classes = spec.postProcessClasses(lines, analysis.classes);
  }
  if (spec.extractStringConstants) {
    const consts = spec.extractStringConstants(lines);
    if (Object.keys(consts).length > 0) analysis.stringConstants = consts;
  }

  // ORM entities & relations. `extractEntityRelations` covers schema-file
  // formats (Prisma); the `entities` domain covers code-embedded models
  // (Go/Rust/Ruby). Both contribute to entityRelations; entities are merged
  // into analysis.classes by name (enrich-or-add).
  const specRelations = spec.extractEntityRelations?.(lines, analysis.classes) ?? [];
  const entityResult = extractEntities(analysis, sourceText, language);
  mergeEntities(analysis, entityResult);
  const relations = [...specRelations, ...entityResult.relations];
  if (relations.length > 0) analysis.entityRelations = relations;
  if (entityResult.schemaTables && entityResult.schemaTables.length > 0) {
    analysis.railsSchemaTables = entityResult.schemaTables;
  }

  return analysis;
}
