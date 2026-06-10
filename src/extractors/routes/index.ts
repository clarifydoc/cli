import type { Tree } from "web-tree-sitter";
import type { RouteInfo, Language } from "../../types/analysis.js";
import type { RouteExtractor } from "./base.js";
import { javascriptRouteExtractor } from "../plugins/javascript/routes/index.js";
import { pythonRouteExtractor } from "../plugins/python/routes.js";
import { csharpRouteExtractor } from "../plugins/csharp/routes/aspnet.js";
import { javaKotlinRouteExtractor } from "../plugins/java-kotlin/routes/spring.js";
import { pascalRouteExtractor } from "../plugins/pascal/routes.js";

/** All registered route extractors */
const extractors: RouteExtractor[] = [
  javascriptRouteExtractor,
  pythonRouteExtractor,
  csharpRouteExtractor,
  javaKotlinRouteExtractor,
  pascalRouteExtractor,
];

/** Language → extractor lookup (built once at import time) */
const extractorMap = new Map<Language, RouteExtractor>();
for (const ext of extractors) {
  for (const lang of ext.languages) {
    extractorMap.set(lang, ext);
  }
}

/**
 * Extract routes and API endpoints from an AST.
 * Delegates to the language plugin's route extractor.
 */
export function extractRoutes(
  tree: Tree,
  sourceText: string,
  language: Language,
): RouteInfo[] {
  const extractor = extractorMap.get(language);
  if (!extractor) return [];
  return extractor.extractRoutes(tree, sourceText);
}

/** Register a custom route extractor at runtime */
export function registerRouteExtractor(extractor: RouteExtractor): void {
  extractors.push(extractor);
  for (const lang of extractor.languages) {
    extractorMap.set(lang, extractor);
  }
}
