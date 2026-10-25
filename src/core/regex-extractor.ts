import { createEmptyAnalysis, type FileAnalysis, type FunctionInfo, type Language, type RouteFact } from "../types/analysis.js";
import { splitLines } from "../extractors/shared/source-lines.js";
import {
  extractFunctionsWithSpec,
  extractClassesWithSpec,
  extractImportsWithSpec,
  extractCallsFromBody,
  deriveExportsFromFnClasses,
  type RegexLangSpec,
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
  /** The source already split by `splitLines`, when the caller has it. */
  presplit?: string[],
): FileAnalysis {
  const analysis = createEmptyAnalysis(filePath, language);
  const spec = regexSpecFor(language);
  if (!spec) return analysis;

  const lines = presplit ?? splitLines(sourceText);

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
  analysis.imports = spec.extractImports ? spec.extractImports(lines) : extractImportsWithSpec(lines, spec);
  analysis.exports = deriveExportsFromFnClasses(analysis.functions, analysis.classes);
  // Test files (unit/integration/e2e specs) never expose real routes.
  const routeFacts: RouteFact[] = [];
  analysis.routes = isTestFile(filePath, language)
    ? []
    : spec.extractRoutes?.(lines, analysis.classes, filePath, analysis.functions, routeFacts) ?? [];
  if (routeFacts.length > 0) analysis.routeFacts = routeFacts;
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
  const setup = topLevelSetup(lines, analysis, spec, filePath);
  if (setup) analysis.functions.unshift(setup);
  const pathRefs = spec.extractPathReferences?.(lines);
  if (pathRefs && pathRefs.length > 0) analysis.pathReferences = pathRefs;
  const diBindings = spec.extractDiBindings?.(lines, filePath);
  if (diBindings && diBindings.length > 0) analysis.diBindings = diBindings;
  const typeAliases = spec.extractTypeAliases?.(lines);
  if (typeAliases && typeAliases.length > 0) analysis.typeAliases = typeAliases;
  const messageHandlers = spec.extractMessageHandlers?.(lines);
  if (messageHandlers && messageHandlers.length > 0) analysis.messageHandlers = messageHandlers;
  const entryPoints = spec.extractEntryPoints?.(lines, filePath);
  if (entryPoints && entryPoints.length > 0) analysis.entryPoints = entryPoints;
  const clientRegistrations = spec.extractHttpClientRegistrations?.(lines, filePath);
  if (clientRegistrations && clientRegistrations.length > 0) analysis.httpClientRegistrations = clientRegistrations;
  const pathArgCalls = spec.extractPathArgCalls?.(lines);
  if (pathArgCalls && pathArgCalls.length > 0) analysis.pathArgCalls = pathArgCalls;
  if (spec.extractStringConstants) {
    const consts = spec.extractStringConstants(lines);
    if (Object.keys(consts).length > 0) analysis.stringConstants = consts;
  }

  // ORM entities & relations. `extractEntityRelations` covers schema-file
  // formats (Prisma); the `entities` domain covers code-embedded models
  // (Go/Rust/Ruby). Both contribute to entityRelations; entities are merged
  // into analysis.classes by name (enrich-or-add).
  const specRelations = spec.extractEntityRelations?.(lines, analysis.classes, analysis.imports) ?? [];
  const entityResult = extractEntities(analysis, sourceText, language);
  mergeEntities(analysis, entityResult);
  const relations = [...specRelations, ...entityResult.relations];
  if (relations.length > 0) analysis.entityRelations = relations;
  if (entityResult.schemaTables && entityResult.schemaTables.length > 0) {
    analysis.railsSchemaTables = entityResult.schemaTables;
  }
  if (entityResult.schemaOps && entityResult.schemaOps.length > 0) analysis.schemaOps = entityResult.schemaOps;

  return analysis;
}

/**
 * A script's top-level statements as the `<setup>` pseudo-function (the
 * tree-sitter path builds the same one from module-level calls): the calls
 * on every line no function or class covers. Null when the spec does not
 * run top-level code for this file, or those lines neither call anything nor
 * touch data.
 */
function topLevelSetup(lines: string[], analysis: FileAnalysis, spec: RegexLangSpec, filePath: string): FunctionInfo | null {
  const on = spec.topLevelCalls;
  if (!on || (on instanceof RegExp && !on.test(filePath))) return null;
  const outside = [...lines];
  for (const span of [...analysis.functions, ...analysis.classes]) {
    for (let i = span.line - 1; i < Math.min(span.endLine, outside.length); i++) outside[i] = "";
  }
  // A deferred block's opening line is the statement that registers it
  // (`get "/x" do`): that call runs now, its body later.
  for (const [start, end] of spec.deferredBlocks?.(lines) ?? []) {
    for (let i = start; i < Math.min(end, outside.length); i++) outside[i] = "";
  }
  // An attribute line (`@RestController`, VB `<Serializable>`) belongs to the
  // declaration below it: it is not a statement the script runs.
  const attribute = spec.attributeLine?.pattern;
  if (attribute) for (let i = 0; i < outside.length; i++) if (attribute.test(outside[i]!)) outside[i] = "";
  const calls = extractCallsFromBody(outside, 0, outside.length, spec.lineCommentPrefixes, spec.callPatterns);
  // Top-level statements that call nothing still run when they read or write
  // data (a view's `json.goals player.goals.count`): that access is `<setup>`'s.
  if (calls.length === 0 && !analysis.dataSources.some((d) => (outside[d.line - 1] ?? "").trim())) return null;
  const setup: FunctionInfo = { name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls, line: 1, endLine: 1 };
  // `let repo = UserRepo()` at the top of a script types `repo.save()` below it.
  const locals = spec.extractLocalTypes?.(outside, setup) ?? [];
  if (locals.length > 0) setup.localTypes = locals;
  return setup;
}
