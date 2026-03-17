import type { Tree } from "web-tree-sitter";
import type { RouteInfo, Language } from "../../types/analysis.js";
import { extractExpressRoutes } from "./express.js";
import { extractReactRouterRoutes } from "./react-router.js";
import { extractNestjsRoutes } from "./nestjs.js";
import { extractVueRouterRoutes } from "./vue-router.js";
import { extractPythonRoutes } from "./python.js";
import { extractAspnetRoutes } from "./aspnet.js";
import { extractSpringRoutes } from "./spring.js";
import { extractPascalRoutes } from "./pascal.js";

/**
 * Extract routes and API endpoints from an AST.
 * Delegates to framework-specific extractors based on language.
 */
export function extractRoutes(
  tree: Tree,
  sourceText: string,
  language: Language,
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  if (language === "typescript" || language === "javascript") {
    extractExpressRoutes(tree.rootNode, routes);
    extractReactRouterRoutes(tree.rootNode, routes);
    extractNestjsRoutes(tree.rootNode, routes);
    extractVueRouterRoutes(tree.rootNode, routes);
  } else if (language === "python") {
    extractPythonRoutes(tree.rootNode, routes);
  } else if (language === "csharp") {
    extractAspnetRoutes(tree.rootNode, routes);
  } else if (language === "java" || language === "kotlin") {
    extractSpringRoutes(tree.rootNode, routes);
  } else if (language === "pascal") {
    extractPascalRoutes(tree.rootNode, routes);
  }

  return routes;
}
