import { readFile } from "fs/promises";
import type { DiscoveredFile } from "./file-discovery.js";
import { writeFileAnalysis, type OutputOptions } from "./output-writer.js";
import { parseSource } from "../parsers/parser-manager.js";
import { parseVueSfc } from "../parsers/vue-sfc.js";
import { parseDfm } from "../parsers/dfm-parser.js";
import { extractImports, extractExports } from "../extractors/imports-exports/index.js";
import { extractFunctions, extractClasses } from "../extractors/functions-classes/index.js";
import { extractSubComponents } from "../extractors/shared/sub-components.js";
import { extractRoutes } from "../extractors/routes/index.js";
import { extractDataSources } from "../extractors/data-sources/index.js";
import { extractDataMutations } from "../extractors/data-mutations/index.js";
import { classifyCalls, extractTopLevelCalls, extractVariableAliases } from "../extractors/shared/call-graph.js";
import { applyAliases } from "../extractors/shared/tsconfig-aliases.js";
import { extractInteractiveElements, extractVueInteractiveElements } from "../extractors/shared/interactive-elements.js";
import { extractEvents } from "../extractors/shared/events.js";
import { computeComplexity } from "./complexity-analyzer.js";
import { scanSecurity } from "./security-scanner.js";
import { extractTypeReferences } from "./type-reference-extractor.js";
import { extractTypeReferencesFromAst } from "../extractors/shared/type-references-ast.js";
import { enrichFileDataSources } from "./import-index.js";
import {
  createEmptyAnalysis,
  type FileAnalysis,
  type Language,
  type ComplexityInfo,
  type SecurityIssue,
  type ImportInfo,
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
    if (tsconfigAliases.size === 0) return;
    for (const imp of a.imports) {
      imp.source = applyAliases(imp.source, tsconfigAliases, projectRoot);
    }
  };

  try {
    const rawSource = await readFile(file.absolutePath, "utf-8");

    // .dfm files use a dedicated parser (no tree-sitter)
    if (file.language === "dfm") {
      const analysis = parseDfm(rawSource, file.relativePath);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);
      analysis.projectId = projectId;
      applyTsconfigAliasesToImports(analysis);
      const dfmTypeRefs = extractTypeReferences(analysis, file.language);
      if (dfmTypeRefs.length > 0) analysis.typeReferences = dfmTypeRefs;
      await writeFileAnalysis(analysis, outputOpts);
      return { analysis, rawSource: null, complexities: [], securityIssues: [] };
    }

    // Languages without tree-sitter grammars: use regex fallback
    const REGEX_ONLY_LANGUAGES: Language[] = ["go", "rust", "ruby", "swift", "lua", "scala", "perl", "vb", "sql", "c", "cpp"];
    if (REGEX_ONLY_LANGUAGES.includes(file.language)) {
      const { extractWithRegex } = await import("./regex-extractor.js");
      const analysis = extractWithRegex(rawSource, file.relativePath, file.language);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);
      analysis.projectId = projectId;
      applyTsconfigAliasesToImports(analysis);
      const fileSecurityIssues = scanSecurity(rawSource, file.relativePath, file.language);
      if (fileSecurityIssues.length > 0) analysis.securityIssues = fileSecurityIssues;
      const regexTypeRefs = extractTypeReferences(analysis, file.language);
      if (regexTypeRefs.length > 0) analysis.typeReferences = regexTypeRefs;
      await writeFileAnalysis(analysis, outputOpts);
      return { analysis, rawSource: null, complexities: [], securityIssues: fileSecurityIssues };
    }

    const isVue = file.relativePath.endsWith(".vue");

    // For .vue files, extract the <script> block and parse that
    let sourceText: string;
    let language: Language = file.language;
    const vueSfc = isVue ? parseVueSfc(rawSource) : null;
    if (isVue) {
      if (!vueSfc!.script) {
        if (verbose) console.log(`    Skipping ${file.relativePath}: no <script> block`);
        return null;
      }
      sourceText = vueSfc!.script;
      language = vueSfc!.scriptLang;
    } else {
      sourceText = rawSource;
    }

    let tree;
    try {
      tree = await parseSource(sourceText, language as any, file.relativePath);
    } catch (parseErr) {
      // Tree-sitter parse failure: fall back to regex extraction
      if (verbose) console.log(`    Parse failed for ${file.relativePath}, using regex fallback`);
      const { extractWithRegex } = await import("./regex-extractor.js");
      const analysis = extractWithRegex(rawSource, file.relativePath, file.language);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);
      analysis.projectId = projectId;
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

    // Run all extractors
    analysis.imports = extractImports(tree, sourceText, language);
    // Rewrite tsconfig path aliases (e.g. "@/utils/foo" → "src/utils/foo")
    // BEFORE classifyCalls so the importMap it builds uses resolved paths.
    applyTsconfigAliasesToImports(analysis);
    analysis.exports = extractExports(tree, sourceText, language);
    analysis.functions = extractFunctions(tree, sourceText, language);
    analysis.classes = extractClasses(tree, sourceText, language);
    analysis.routes = extractRoutes(tree, sourceText, language);
    analysis.dataSources = extractDataSources(tree, sourceText, language);
    // Backfill missing `target` on data sources by tracing each call's root
    // identifier through this file's imports (named imports, namespace
    // aliases, and global/wildcard namespaces).
    enrichFileDataSources(analysis);
    analysis.dataMutations = extractDataMutations(tree, sourceText, language);
    analysis.events = extractEvents(sourceText, language);
    analysis.subComponents = extractSubComponents(
      tree,
      sourceText,
      language,
      analysis.imports,
    );

    // Extract top-level calls (Vue <script setup>, module-level hooks)
    // and variable aliases (const userStore = useUserStore())
    const topLevelCalls = extractTopLevelCalls(tree, language);
    const variableAliases = extractVariableAliases(tree, analysis.imports, language);

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
    analysis.interactiveElements = extractInteractiveElements(tree, sourceText, language);

    // Infer frameworks for this specific file based on its imports
    analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);

    // For .vue files, also add template components and interactive elements
    if (isVue && vueSfc) {
      if (vueSfc.template) {
        analysis.interactiveElements.push(
          ...extractVueInteractiveElements(vueSfc.template, rawSource),
        );
      }
      for (const comp of vueSfc.templateComponents) {
        const importSource =
          analysis.imports.find((imp) =>
            imp.specifiers.includes(comp.name),
          )?.source ?? null;
        if (!analysis.subComponents.some((sc) => sc.name === comp.name)) {
          analysis.subComponents.push({
            name: comp.name,
            importSource,
            props: comp.props,
            line: comp.line,
          });
        }
      }
    }

    // Next.js / Nuxt file-based routing: infer route from file path
    const fileRoute = inferFileBasedRoute(file.relativePath, frameworkIds);
    if (fileRoute) {
      analysis.routes.push(fileRoute);
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
    const astLevelTypeRefs = extractTypeReferencesFromAst(tree, language, file.relativePath);
    const combinedTypeRefs = mergeTypeRefs(fileLevelTypeRefs, astLevelTypeRefs);
    if (combinedTypeRefs.length > 0) analysis.typeReferences = combinedTypeRefs;

    await writeFileAnalysis(analysis, outputOpts);

    // Return raw source for frontend route files (needed for screen building)
    const hasFrontendRoute = analysis.routes.some((r) => r.kind === "frontend");
    return {
      analysis,
      rawSource: hasFrontendRoute ? rawSource : null,
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

/** Import source patterns → framework id */
const IMPORT_FRAMEWORK_MAP: Record<string, string> = {
  "react": "react",
  "react-dom": "react",
  "react-router": "react-router",
  "react-router-dom": "react-router",
  "next": "nextjs",
  "next/router": "nextjs",
  "next/navigation": "nextjs",
  "vue": "vue",
  "vue-router": "vue-router",
  "nuxt": "nuxt",
  "pinia": "pinia",
  "vuex": "vuex",
  "express": "express",
  "@nestjs/common": "nestjs",
  "@nestjs/core": "nestjs",
  "fastify": "fastify",
  "@angular/core": "angular",
  "@angular/router": "angular",
  "react-redux": "react-redux",
  "@reduxjs/toolkit": "redux",
  "@tanstack/react-query": "react-query",
  "io.ktor.server.routing": "ktor",
  "org.springframework.web.bind.annotation": "spring-web",
  // ORM imports
  "@prisma/client": "prisma",
  "prisma": "prisma",
  "typeorm": "typeorm",
  "sequelize": "sequelize",
  "sequelize-typescript": "sequelize",
  "drizzle-orm": "drizzle",
  "@mikro-orm/core": "mikro-orm",
  "mongoose": "mongoose",
  "knex": "knex",
  "objection": "objection",
  "sqlalchemy": "sqlalchemy",
  "django.db.models": "django-orm",
  "tortoise": "tortoise-orm",
  "peewee": "peewee",
  "Microsoft.EntityFrameworkCore": "ef-core",
  "System.Data.Entity": "ef6",
  "Dapper": "dapper",
  "NHibernate": "nhibernate",
  "org.hibernate": "hibernate",
  "javax.persistence": "hibernate",
  "jakarta.persistence": "hibernate",
  "org.springframework.data.jpa": "spring-data-jpa",
  "org.mybatis": "mybatis",
  "org.jooq": "jooq",
  "org.jetbrains.exposed": "exposed",
  "active_record": "active-record",
  "sequel": "sequel",
  "Doctrine\\ORM": "doctrine",
  "Illuminate\\Database": "eloquent",
  "gorm.io/gorm": "gorm",
  "github.com/jmoiron/sqlx": "sqlx",
  "entgo.io/ent": "ent",
  "diesel": "diesel",
  "sea_orm": "sea-orm",
  "sqlx": "rust-sqlx",
};

/**
 * Infer which frameworks a specific file uses, based on its imports.
 * Only includes project-level frameworks that the file actually references.
 */
export function inferFileFrameworks(
  imports: ImportInfo[],
  filePath: string,
  projectFrameworkIds: string[],
): string[] {
  const fileFrameworks = new Set<string>();

  for (const imp of imports) {
    // Check exact match
    const exact = IMPORT_FRAMEWORK_MAP[imp.source];
    if (exact) {
      fileFrameworks.add(exact);
      continue;
    }
    // Check prefix match (e.g., "react-router-dom/..." or "org.springframework.web.bind.annotation.*")
    for (const [pattern, fwId] of Object.entries(IMPORT_FRAMEWORK_MAP)) {
      if (imp.source.startsWith(pattern + "/") || imp.source.startsWith(pattern + ".")) {
        fileFrameworks.add(fwId);
      }
    }
  }

  // .vue files are implicitly Vue
  if (filePath.endsWith(".vue")) {
    fileFrameworks.add("vue");
  }

  return [...fileFrameworks];
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
