import type { Tree } from "web-tree-sitter";
import type { RouteInfo, Language } from "../../types/analysis.js";
import { extractExpressRoutes } from "../plugins/javascript/routes/express.js";
import { extractReactRouterRoutes } from "../plugins/javascript/routes/react-router.js";
import { extractNestjsRoutes } from "../plugins/javascript/routes/nestjs.js";
import { extractVueRouterRoutes } from "../plugins/javascript/routes/vue-router.js";
import { extractPythonRoutes } from "../plugins/python/routes.js";
import { extractAspnetRoutes } from "../plugins/csharp/routes/aspnet.js";
import { extractSpringRoutes } from "../plugins/java-kotlin/routes/spring.js";
import { extractPascalRoutes } from "../plugins/pascal/routes.js";

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
