import { readFile } from "fs/promises";
import { discoverFiles, type DiscoveryOptions } from "./file-discovery.js";
import {
  gatherProjectInfo,
  detectFrameworks,
} from "./framework-detector.js";
import {
  writeFileAnalysis,
  writeProjectSummary,
  type OutputOptions,
} from "./output-writer.js";
import { parseSource } from "../parsers/parser-manager.js";
import { parseVueSfc } from "../parsers/vue-sfc.js";
import { parseDfm } from "../parsers/dfm-parser.js";
import { extractImports, extractExports } from "../extractors/imports-exports/index.js";
import { extractFunctions, extractClasses } from "../extractors/functions-classes/index.js";
import { extractSubComponents } from "../extractors/sub-components.js";
import { extractRoutes } from "../extractors/routes/index.js";
import { extractDataSources } from "../extractors/data-sources/index.js";
import { extractDataMutations } from "../extractors/data-mutations/index.js";
import {
  createEmptyAnalysis,
  type FileAnalysis,
  type ProjectAnalysis,
} from "../types/analysis.js";

export interface AnalyzeOptions {
  projectRoot: string;
  outputDir: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  pretty?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
}

export interface AnalyzeResult {
  fileCount: number;
  files: string[];
  outputDir: string;
}

/**
 * Main analysis pipeline:
 * 1. Discover files
 * 2. Detect frameworks
 * 3. Parse each file and run extractors
 * 4. Write per-file JSON output
 * 5. Write project summary
 */
export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { projectRoot, outputDir, verbose, dryRun } = options;

  // Step 1: Discover files
  if (verbose) console.log("Discovering files...");
  const discoveryOpts: DiscoveryOptions = {
    include: options.include,
    exclude: options.exclude,
    maxFiles: options.maxFiles,
  };
  const files = await discoverFiles(projectRoot, discoveryOpts);

  if (verbose) console.log(`Found ${files.length} source files`);

  if (dryRun) {
    return {
      fileCount: files.length,
      files: files.map((f) => f.relativePath),
      outputDir,
    };
  }

  // Step 2: Detect frameworks
  if (verbose) console.log("Detecting frameworks...");
  const projectInfo = await gatherProjectInfo(projectRoot);
  const frameworks = detectFrameworks(projectInfo);
  const frameworkIds = frameworks.map((f) => f.id);

  if (verbose) {
    if (frameworks.length > 0) {
      console.log(
        `Detected: ${frameworks.map((f) => f.name).join(", ")}`,
      );
    } else {
      console.log("No frameworks detected");
    }
  }

  // Step 3: Analyze each file
  const outputOpts: OutputOptions = { outputDir, pretty: options.pretty };
  const allAnalyses: FileAnalysis[] = [];

  for (const file of files) {
    if (verbose) console.log(`  Analyzing: ${file.relativePath}`);

    try {
      const rawSource = await readFile(file.absolutePath, "utf-8");

      // .dfm files use a dedicated parser (no tree-sitter)
      if (file.language === "dfm") {
        const analysis = parseDfm(rawSource, file.relativePath);
        analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);
        allAnalyses.push(analysis);
        await writeFileAnalysis(analysis, outputOpts);
        continue;
      }

      const isVue = file.relativePath.endsWith(".vue");

      // For .vue files, extract the <script> block and parse that
      let sourceText: string;
      let language = file.language;
      if (isVue) {
        const sfc = parseVueSfc(rawSource);
        if (!sfc.script) {
          if (verbose) console.log(`    Skipping ${file.relativePath}: no <script> block`);
          continue;
        }
        sourceText = sfc.script;
        language = sfc.scriptLang;
      } else {
        sourceText = rawSource;
      }

      const tree = await parseSource(sourceText, language, file.relativePath);

      const analysis = createEmptyAnalysis(file.relativePath, language);

      // Run all extractors
      analysis.imports = extractImports(tree, sourceText, language);
      analysis.exports = extractExports(tree, sourceText, language);
      analysis.functions = extractFunctions(tree, sourceText, language);
      analysis.classes = extractClasses(tree, sourceText, language);
      analysis.routes = extractRoutes(tree, sourceText, language);
      analysis.dataSources = extractDataSources(tree, sourceText, language);
      analysis.dataMutations = extractDataMutations(tree, sourceText, language);
      analysis.subComponents = extractSubComponents(
        tree,
        sourceText,
        language,
        analysis.imports,
      );

      // Infer frameworks for this specific file based on its imports
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath, frameworkIds);

      // For .vue files, also add template components
      if (isVue) {
        const sfc = parseVueSfc(rawSource);
        for (const comp of sfc.templateComponents) {
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

      allAnalyses.push(analysis);
      await writeFileAnalysis(analysis, outputOpts);
    } catch (err) {
      console.error(
        `  Error analyzing ${file.relativePath}: ${(err as Error).message}`,
      );
      if (verbose) {
        console.error((err as Error).stack);
      }
    }
  }

  // Step 4: Write project summary
  if (verbose) console.log("Writing project summary...");
  const componentGraph = buildComponentGraph(allAnalyses);
  const allRoutes = allAnalyses.flatMap((a) => a.routes);

  const summary: ProjectAnalysis = {
    projectRoot,
    detectedFrameworks: frameworks,
    files: allAnalyses.map((a) => a.filePath),
    componentGraph,
    routeMap: allRoutes,
    analyzedAt: new Date().toISOString(),
  };

  await writeProjectSummary(summary, outputOpts);

  return {
    fileCount: allAnalyses.length,
    files: allAnalyses.map((a) => a.filePath),
    outputDir,
  };
}

/** Build a graph of file -> files it imports */
function buildComponentGraph(
  analyses: FileAnalysis[],
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};

  // Build a map of export names to file paths for resolution
  const exportToFile = new Map<string, string>();
  for (const a of analyses) {
    for (const exp of a.exports) {
      exportToFile.set(exp.name, a.filePath);
    }
  }

  for (const a of analyses) {
    const refs: string[] = [];

    for (const imp of a.imports) {
      // Try to resolve relative imports to actual files
      if (imp.source.startsWith(".")) {
        // Find matching file
        const match = analyses.find((other) => {
          const otherBase = other.filePath
            .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
            .replace(/\/index$/, "");
          return imp.source.endsWith(otherBase) || otherBase.endsWith(imp.source.replace(/^\.\//, ""));
        });
        if (match) refs.push(match.filePath);
      }
    }

    // Also track sub-component references
    for (const comp of a.subComponents) {
      if (comp.importSource) {
        const match = analyses.find((other) => {
          const otherBase = other.filePath.replace(
            /\.(ts|tsx|js|jsx)$/,
            "",
          );
          return otherBase.endsWith(
            comp.importSource!.replace(/^\.\//, ""),
          );
        });
        if (match && !refs.includes(match.filePath)) {
          refs.push(match.filePath);
        }
      }
    }

    if (refs.length > 0) {
      graph[a.filePath] = refs;
    }
  }

  return graph;
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

import type { ImportInfo, RouteInfo } from "../types/analysis.js";

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
};

/**
 * Infer which frameworks a specific file uses, based on its imports.
 * Only includes project-level frameworks that the file actually references.
 */
function inferFileFrameworks(
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
