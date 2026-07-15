import { readFile } from "fs/promises";
import type { DiscoveredFile } from "./file-discovery.js";
import { writeFileAnalysis, type OutputOptions } from "./output-writer.js";
import { parseSource } from "../parsers/parser-manager.js";
import { extractImports, extractExports } from "../extractors/imports-exports/index.js";
import { extractFunctions, extractClasses } from "../extractors/functions-classes/index.js";
import { extractRoutes } from "../extractors/routes/index.js";
import { extractDataAccess } from "../extractors/data-access.js";
import { extractEntities, mergeEntities } from "../extractors/entities/index.js";
import { classifyCalls, extractTopLevelCalls } from "../extractors/shared/call-graph.js";
import { dirname } from "path";
import { applyAliases, loadTsconfigAliasesForDir } from "../extractors/shared/tsconfig-aliases.js";
import { pluginFor, astHooksFor, inferFileFrameworks, ensureLanguagesLoaded } from "../extractors/registry.js";
import { computeComplexity } from "./complexity-analyzer.js";
import { scanSecurity, isMinifiedSource, isVendoredSource } from "./security-scanner.js";
import { extractTypeReferences } from "./type-reference-extractor.js";
import { enrichFileDataSources } from "./import-index.js";
import { isTestFile } from "./test-file-detector.js";
import {
  createEmptyAnalysis,
  type FileAnalysis,
  type Language,
  type ComplexityInfo,
  type SecurityIssue,
  type RouteInfo,
} from "../types/analysis.js";

// ─── Per-file analysis task / result ─────────────────────────────────────

export interface FileTask {
  file: DiscoveredFile;
  frameworkIds: string[];
  projectId: string;
  outputOpts: OutputOptions;
  verbose: boolean;
  projectRoot: string;
  /** tsconfig.json paths-style aliases for the project (may be empty). */
  tsconfigAliases: Map<string, string>;
}

export interface FileResult {
  analysis: FileAnalysis;
  rawSource: string | null; // non-null only for frontend route files
  complexities: ComplexityInfo[];
  securityIssues: SecurityIssue[];
}

// ─── Single-file analysis ────────────────────────────────────────────────

/**
 * Analyze a single file: read, parse, extract, write JSON.
 * Returns null on error (error is logged internally).
 */
export async function analyzeFile(task: FileTask): Promise<FileResult | null> {
  const { file, frameworkIds, projectId, outputOpts, verbose, projectRoot, tsconfigAliases } = task;

  const applyTsconfigAliasesToImports = (a: FileAnalysis): void => {
    if (a.imports.length === 0) return; // nothing to rewrite — skip the tsconfig lookup
    // Nearest tsconfig wins (the compiler's own rule): monorepo sub-projects
    // define their own `paths` and the repo root often has NO tsconfig, so
    // the task-level root map alone left whole SPAs' aliased imports — and
    // with them every cross-file link in those SPAs — unresolved.
    const nearest = loadTsconfigAliasesForDir(dirname(file.absolutePath));
    const aliases = nearest.size > 0 ? nearest : tsconfigAliases;
    if (aliases.size === 0) return;
    for (const imp of a.imports) {
      imp.source = applyAliases(imp.source, aliases, projectRoot);
    }
  };

  try {
    // Safety net for entry points that never ran the analyzer's bulk load
    // (worker threads see it via the analyzer-set activation; watch mode and
    // single-file callers may not) — a no-op when the plugin is loaded.
    await ensureLanguagesLoaded([file.language]);
    const filePlugin = pluginFor(file.language);
    const rawSource = await readFile(file.absolutePath, filePlugin?.sourceEncoding ?? "utf-8");
    // Flag minified/bundled artifacts once; every branch below stamps it on
    // the analysis so project-level detectors can exclude these files.
    const minified = isMinifiedSource(rawSource);
    const vendored = isVendoredSource(rawSource);

    // Formats with their own dedicated parser (e.g. Delphi .dfm — no tree-sitter)
    if (filePlugin?.customParse) {
      const analysis = filePlugin.customParse(rawSource, file.relativePath);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath);
      analysis.projectId = projectId;
      if (minified) analysis.minified = true;
      if (vendored) analysis.vendored = true;
      applyTsconfigAliasesToImports(analysis);
      const customTypeRefs = extractTypeReferences(analysis, file.language);
      if (customTypeRefs.length > 0) analysis.typeReferences = customTypeRefs;
      await writeFileAnalysis(analysis, outputOpts);
      return { analysis, rawSource: null, complexities: [], securityIssues: [] };
    }

    // Languages without tree-sitter grammars: use regex extraction
    if (filePlugin?.parsing === "regex") {
      // Content-sniffing preprocess, mirroring the tree-sitter path below: a
      // plugin that claims a broad extension (springxml claims `.xml`) skips
      // the files that aren't its format instead of emitting empty analyses.
      const pre = filePlugin.preprocess?.(rawSource, file.relativePath);
      if (pre && "skip" in pre) {
        if (verbose) console.log(`    Skipping ${file.relativePath}: ${pre.skip}`);
        return null;
      }
      const regexSource = pre?.sourceText ?? rawSource;
      const { extractWithRegex } = await import("./regex-extractor.js");
      const analysis = extractWithRegex(regexSource, file.relativePath, pre?.language ?? file.language);
      pre?.postExtract?.(analysis, rawSource);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath);
      analysis.projectId = projectId;
      if (minified) analysis.minified = true;
      if (vendored) analysis.vendored = true;
      applyTsconfigAliasesToImports(analysis);
      const fileSecurityIssues = scanSecurity(rawSource, file.relativePath, file.language);
      if (fileSecurityIssues.length > 0) analysis.securityIssues = fileSecurityIssues;
      const regexTypeRefs = extractTypeReferences(analysis, file.language);
      if (regexTypeRefs.length > 0) analysis.typeReferences = regexTypeRefs;
      await writeFileAnalysis(analysis, outputOpts);
      // Keep raw source for regex-path UI files that back a screen (HTML pages,
      // Blazor .razor) so buildScreen can recover the page caption + navigation.
      const isUiSource =
        analysis.routes.some((r) => r.kind === "frontend") ||
        analysis.subComponents.length > 0 ||
        analysis.interactiveElements.length > 0;
      return { analysis, rawSource: isUiSource ? rawSource : null, complexities: [], securityIssues: fileSecurityIssues };
    }

    // Container-format preprocessing (e.g. Vue SFC → its <script> block)
    let sourceText: string = rawSource;
    let language: Language = file.language;
    let postExtract: ((analysis: FileAnalysis, raw: string) => void) | undefined;
    const pre = filePlugin?.preprocess?.(rawSource, file.relativePath);
    if (pre) {
      if ("skip" in pre) {
        if (verbose) console.log(`    Skipping ${file.relativePath}: ${pre.skip}`);
        return null;
      }
      sourceText = pre.sourceText;
      language = pre.language;
      postExtract = pre.postExtract;
      // The effective language can differ from the file's (Vue SFC → its
      // <script> block); make sure ITS plugin is loaded too.
      await ensureLanguagesLoaded([language]);
    }

    let tree;
    try {
      tree = await parseSource(sourceText, language as any, file.relativePath);
    } catch (parseErr) {
      // Tree-sitter parse failure: fall back to regex extraction
      if (verbose) console.log(`    Parse failed for ${file.relativePath}, using regex fallback`);
      const { extractWithRegex } = await import("./regex-extractor.js");
      const analysis = extractWithRegex(rawSource, file.relativePath, file.language);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath);
      analysis.projectId = projectId;
      if (minified) analysis.minified = true;
      if (vendored) analysis.vendored = true;
      applyTsconfigAliasesToImports(analysis);
      const fileSecurityIssues = scanSecurity(rawSource, file.relativePath, file.language);
      if (fileSecurityIssues.length > 0) analysis.securityIssues = fileSecurityIssues;
      const fallbackTypeRefs = extractTypeReferences(analysis, file.language);
      if (fallbackTypeRefs.length > 0) analysis.typeReferences = fallbackTypeRefs;
      await writeFileAnalysis(analysis, outputOpts);
      return { analysis, rawSource: null, complexities: [], securityIssues: fileSecurityIssues };
    }

    const analysis = createEmptyAnalysis(file.relativePath, language);
    analysis.projectId = projectId;
    if (minified) analysis.minified = true;
      if (vendored) analysis.vendored = true;

    // Language-specific AST hooks (looked up for the effective language —
    // for .vue files that's the <script> block's language).
    const hooks = astHooksFor(language);

    // Run all extractors
    analysis.imports = extractImports(tree, sourceText, language);
    // Rewrite tsconfig path aliases (e.g. "@/utils/foo" → "src/utils/foo")
    // BEFORE classifyCalls so the importMap it builds uses resolved paths.
    applyTsconfigAliasesToImports(analysis);
    analysis.exports = extractExports(tree, sourceText, language);
    analysis.functions = extractFunctions(tree, sourceText, language);
    analysis.classes = extractClasses(tree, sourceText, language);
    // Test files (unit/integration/e2e specs) never expose real routes — a
    // Cypress `cy.get('button')` or `request(app).get('/x')` is not an endpoint.
    const isTest = isTestFile(file.relativePath, language);
    analysis.routes = isTest ? [] : extractRoutes(tree, sourceText, language, analysis.filePath);
    // Data sources + mutations share one tree walk (extractDataAccess);
    // mutations are assigned further down at their original position.
    const dataAccess = extractDataAccess(tree, sourceText, language);
    analysis.dataSources = dataAccess.dataSources;
    // Backfill missing `target` on data sources by tracing each call's root
    // identifier through this file's imports (named imports, namespace
    // aliases, and global/wildcard namespaces).
    enrichFileDataSources(analysis);
    // ORM entity & relationship extraction (TypeORM/Mongoose/Sequelize, JPA,
    // EF Core, etc.). Entities are merged into analysis.classes by name so they
    // flow into the class/data-model graph; relations are persisted separately.
    const entityResult = extractEntities(analysis, sourceText, language);
    mergeEntities(analysis, entityResult);
    if (entityResult.relations.length > 0) analysis.entityRelations = entityResult.relations;
    if (entityResult.schemaTables && entityResult.schemaTables.length > 0) {
      analysis.railsSchemaTables = entityResult.schemaTables;
    }
    analysis.dataMutations = dataAccess.dataMutations;
    analysis.events = hooks?.events?.(sourceText) ?? [];
    analysis.subComponents = hooks?.subComponents?.(tree, sourceText, analysis.imports) ?? [];

    // Extract top-level calls (Vue <script setup>, module-level hooks)
    // and variable aliases (const userStore = useUserStore())
    const topLevelCalls = extractTopLevelCalls(tree, language);
    const variableAliases = hooks?.variableAliases?.(tree, analysis.imports) ?? new Map<string, string>();

    if (topLevelCalls.length > 0) {
      const setupFn = {
        name: "<setup>",
        params: [],
        returnType: null,
        isAsync: false,
        isExported: false,
        decorators: [],
        calls: topLevelCalls,
        line: 1,
        endLine: 1,
      };
      analysis.functions.unshift(setupFn);
    }

    // Classify calls using import context, language patterns, and variable aliases
    for (const fn of analysis.functions) {
      fn.calls = classifyCalls(fn.calls, analysis.imports, language, variableAliases);
    }
    for (const cls of analysis.classes) {
      for (const method of cls.methods) {
        method.calls = classifyCalls(method.calls, analysis.imports, language, variableAliases);
      }
    }
    for (const route of analysis.routes) {
      route.calls = classifyCalls(route.calls, analysis.imports, language, variableAliases);
    }
    // Also classify calls inside data source callbacks (lifecycle hooks, watchers)
    for (const ds of analysis.dataSources) {
      if (ds.calls.length > 0) {
        ds.calls = classifyCalls(ds.calls, analysis.imports, language, variableAliases);
      }
    }

    // Extract interactive elements (buttons, inputs, forms with event bindings)
    analysis.interactiveElements = hooks?.interactiveElements?.(tree, sourceText) ?? [];

    // Angular @Component with an external templateUrl: record the url so a
    // project-level pass can read the sibling .html and back-fill this
    // component's template-derived data (interactiveElements/templateTree).
    const externalTpl = hooks?.externalTemplate?.(sourceText);
    if (externalTpl) analysis.angularTemplateUrl = externalTpl;

    // Web Component registrations (customElements.define / Lit @customElement),
    // so the component graph can join `<kebab-tag>` markup usages to this file.
    const customEls = hooks?.customElements?.(sourceText);
    if (customEls && customEls.length > 0) analysis.customElements = customEls;

    // Designer screens embedded in source files (e.g. WinForms *.Designer.cs).
    const hookScreens = hooks?.screens?.(tree, sourceText, file.relativePath);
    if (hookScreens && hookScreens.length > 0) analysis.screens = hookScreens;

    // Nested component tree from the AST (React JSX, Angular inline templates).
    // Vue/Svelte SFCs populate this from their preprocess postExtract instead,
    // which runs below and overrides this (their <script> AST has no JSX).
    analysis.templateTree = hooks?.componentTree?.(tree, sourceText, analysis.imports) ?? [];

    // Infer frameworks for this specific file based on its imports
    analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath);

    // Merge container-format data back in (e.g. Vue template elements/components)
    postExtract?.(analysis, rawSource);

    // Next.js / Nuxt file-based routing: infer route from file path
    // (skipped for test files, same as AST-extracted routes).
    const fileRoute = isTest ? null : inferFileBasedRoute(file.relativePath, frameworkIds);
    if (fileRoute) {
      analysis.routes.push(fileRoute);
    }
    // SvelteKit file-based routing (`src/routes/**/+page.svelte`,
    // `+server.ts`) — a `+server` endpoint yields one api route per exported
    // HTTP-method handler, so needs the analysis, not just the path.
    if (!isTest) {
      for (const r of inferSvelteKitRoutes(file.relativePath, analysis, frameworkIds)) {
        analysis.routes.push(r);
      }
    }

    // Detect React directives: 'use client' / 'use server'
    detectDirectives(sourceText, analysis);

    // Advanced per-file analysis: complexity and security
    const fileComplexities = computeComplexity(tree, language, analysis.functions, analysis.classes);
    const fileSecurityIssues = scanSecurity(sourceText, file.relativePath, language);

    // Attach to the analysis itself so an incremental run can read both back
    // from disk and reconstruct the project-level aggregates without re-parsing.
    if (fileComplexities.length > 0) analysis.complexities = fileComplexities;
    if (fileSecurityIssues.length > 0) analysis.securityIssues = fileSecurityIssues;

    // Type-position references — combine FileAnalysis-level refs (classes,
    // named functions) with AST-level refs (arrow functions, variable type
    // annotations, casts, new-expressions). Dedup on
    // (typeName, kind, sourceFile, sourceLine, sourceSymbol).
    const fileLevelTypeRefs = extractTypeReferences(analysis, language);
    const astLevelTypeRefs = hooks?.typeReferences?.(tree, file.relativePath) ?? [];
    const combinedTypeRefs = mergeTypeRefs(fileLevelTypeRefs, astLevelTypeRefs);
    if (combinedTypeRefs.length > 0) analysis.typeReferences = combinedTypeRefs;

    await writeFileAnalysis(analysis, outputOpts);

    // Keep raw source for files that can back a screen: route-config files
    // (caption/nav) AND the UI component files routes resolve to (Vue/JSX/TSX,
    // or anything with template components / interactive elements). buildScreen
    // re-parses the .vue template from this to recover nesting + v-for.
    const hasFrontendRoute = analysis.routes.some((r) => r.kind === "frontend");
    const isUiSource =
      hasFrontendRoute ||
      /\.(vue|svelte|jsx|tsx)$/.test(analysis.filePath) ||
      analysis.subComponents.length > 0 ||
      analysis.interactiveElements.length > 0;
    return {
      analysis,
      rawSource: isUiSource ? rawSource : null,
      complexities: fileComplexities,
      securityIssues: fileSecurityIssues,
    };
  } catch (err) {
    console.error(
      `  Error analyzing ${file.relativePath}: ${(err as Error).message}`,
    );
    if (verbose) {
      console.error((err as Error).stack);
    }
    return null;
  }
}

/**
 * Merge two TypeReference lists, dropping exact duplicates. The keys include
 * source position so legitimately distinct refs at different sites survive,
 * while the same `(typeName, kind, file, line, symbol)` from two extractors
 * (e.g. FileAnalysis classes + AST walker) collapses to one entry.
 */
function mergeTypeRefs(
  fileLevel: import("../types/analysis.js").TypeReference[],
  astLevel: import("../types/analysis.js").TypeReference[],
): import("../types/analysis.js").TypeReference[] {
  const seen = new Set<string>();
  const out: import("../types/analysis.js").TypeReference[] = [];
  for (const r of [...fileLevel, ...astLevel]) {
    const key = `${r.typeName}::${r.usageKind}::${r.sourceFile}::${r.sourceLine}::${r.sourceSymbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Infer a frontend route from file path for file-based routing frameworks.
 * Supports Next.js (pages/, app/) and Nuxt (pages/).
 */
function inferFileBasedRoute(
  relativePath: string,
  frameworkIds: string[],
): RouteInfo | null {
  const isNextjs = frameworkIds.includes("nextjs");
  const isNuxt = frameworkIds.includes("vue") || frameworkIds.includes("vue-router");

  if (!isNextjs && !isNuxt) return null;

  const normalized = relativePath.replace(/\\/g, "/");

  // Next.js pages/ directory
  let match = normalized.match(/^(?:src\/)?pages\/(.+)\.(tsx?|jsx?)$/);
  if (match) {
    const route = filePathToRoute(match[1]);
    if (route === "/_app" || route === "/_document" || route === "/api") return null;
    return {
      path: route,
      httpMethod: null,
      kind: route.startsWith("/api/") ? "api" : "frontend",
      handler: null,
      calls: [],
      middleware: [],
      line: 1,
    };
  }

  // Next.js app/ directory (page.tsx)
  match = normalized.match(/^(?:src\/)?app\/(.+)\/page\.(tsx?|jsx?)$/);
  if (match) {
    return {
      path: filePathToRoute(match[1]),
      httpMethod: null,
      kind: "frontend",
      handler: null,
      calls: [],
      middleware: [],
      line: 1,
    };
  }

  // Next.js app/ route handlers (route.ts)
  match = normalized.match(/^(?:src\/)?app\/(.+)\/route\.(tsx?|jsx?)$/);
  if (match) {
    return {
      path: filePathToRoute(match[1]),
      httpMethod: null,
      kind: "api",
      handler: null,
      calls: [],
      middleware: [],
      line: 1,
    };
  }

  // Nuxt pages/ directory
  match = normalized.match(/^pages\/(.+)\.vue$/);
  if (match) {
    return {
      path: filePathToRoute(match[1]),
      httpMethod: null,
      kind: "frontend",
      handler: null,
      calls: [],
      middleware: [],
      line: 1,
    };
  }

  return null;
}

const SVELTEKIT_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * SvelteKit file-based routing under `src/routes/`:
 *   - `**​/+page.svelte`        → a frontend route (the page component)
 *   - `**​/+server.{ts,js}`      → an API endpoint; each exported HTTP-method
 *                                 function (`export function GET`, `export const
 *                                 POST = …`) becomes one `api` route, handler =
 *                                 the method name, so the endpoint's data calls
 *                                 join into the trace like any other route.
 *
 * Path derivation mirrors SvelteKit's: route groups `(auth)` are dropped from
 * the URL, `[id]`→`:id`, `[...rest]`→`*`, `[[opt]]`→`:opt?`.
 */
function inferSvelteKitRoutes(
  relativePath: string,
  analysis: FileAnalysis,
  frameworkIds: string[],
): RouteInfo[] {
  if (!frameworkIds.includes("sveltekit")) return [];
  const normalized = relativePath.replace(/\\/g, "/");

  const page = normalized.match(/^(?:src\/)?routes\/(.*)\+page\.svelte$/);
  if (page) {
    return [{
      path: svelteKitRoutePath(page[1]!),
      httpMethod: null,
      kind: "frontend",
      handler: null,
      componentPath: null,
      calls: [],
      middleware: [],
      line: 1,
    }];
  }

  const server = normalized.match(/^(?:src\/)?routes\/(.*)\+server\.(?:tsx?|jsx?)$/);
  if (server) {
    const path = svelteKitRoutePath(server[1]!);
    // Exported HTTP-method handlers appear as functions or exported consts.
    const methods = new Set<string>();
    for (const fn of analysis.functions) {
      if (SVELTEKIT_HTTP_METHODS.has(fn.name)) methods.add(fn.name);
    }
    for (const exp of analysis.exports) {
      if (SVELTEKIT_HTTP_METHODS.has(exp.name)) methods.add(exp.name);
    }
    return [...methods].map((method) => ({
      path,
      httpMethod: method,
      kind: "api" as const,
      handler: method,
      calls: [],
      middleware: [],
      line: analysis.functions.find((f) => f.name === method)?.line ?? 1,
    }));
  }

  return [];
}

/** SvelteKit route dir → URL path (drops `(groups)`, maps `[param]` forms). */
function svelteKitRoutePath(dir: string): string {
  const segments = dir
    .split("/")
    .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s)) // drop route groups
    .map((s) =>
      s
        .replace(/\[\.\.\.(\w+)\]/g, "*") // [...rest] -> *
        .replace(/\[\[(\w+)\]\]/g, ":$1?") // [[opt]] -> :opt?
        .replace(/\[(\w+)\]/g, ":$1"), // [id] -> :id
    );
  return "/" + segments.join("/");
}

/** Convert file path segments to a route path */
function filePathToRoute(filePath: string): string {
  return (
    "/" +
    filePath
      .replace(/\/index$/, "") // index.tsx -> /
      .replace(/\[\.\.\.(\w+)\]/g, "*") // [...slug] -> *
      .replace(/\[(\w+)\]/g, ":$1") // [id] -> :id
  );
}

/** Detect 'use client' / 'use server' directives (React Server Components) */
function detectDirectives(
  sourceText: string,
  analysis: FileAnalysis,
) {
  const firstLine = sourceText.trimStart().split("\n")[0];
  if (firstLine.includes("'use client'") || firstLine.includes('"use client"')) {
    analysis.dataSources.push({
      kind: "prop",
      name: "use client",
      target: "React Server Component: client boundary",
      calls: [],
      line: 1,
    });
  }
  if (firstLine.includes("'use server'") || firstLine.includes('"use server"')) {
    analysis.dataSources.push({
      kind: "prop",
      name: "use server",
      target: "React Server Component: server action",
      calls: [],
      line: 1,
    });
  }
}
