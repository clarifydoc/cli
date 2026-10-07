import type { Tree } from "web-tree-sitter";
import type { RouteInfo, RouteFact, Language } from "../../types/analysis.js";
import { pluginFor } from "../registry.js";

/**
 * Extract routes and API endpoints from an AST.
 * Delegates to the language plugin's route extractor (`meta.routes`).
 */
export function extractRoutes(
  tree: Tree,
  sourceText: string,
  language: Language,
  filePath?: string,
  facts?: RouteFact[],
): RouteInfo[] {
  const extractor = pluginFor(language)?.routes;
  if (!extractor) return [];
  return extractor.extractRoutes(tree, sourceText, filePath, facts);
}
