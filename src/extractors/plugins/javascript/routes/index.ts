import type { Tree } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { extractExpressRoutes } from "./express.js";
import { extractReactRouterRoutes } from "./react-router.js";
import { extractNestjsRoutes } from "./nestjs.js";
import { extractVueRouterRoutes } from "./vue-router.js";

/**
 * JS/TS route extraction: runs every supported framework extractor in a
 * fixed order (the order routes appear in the output).
 */
export const javascriptRouteExtractor: RouteExtractor = {
  languages: ["typescript", "javascript"],

  extractRoutes(tree: Tree, _sourceText: string): RouteInfo[] {
    const routes: RouteInfo[] = [];
    extractExpressRoutes(tree.rootNode, routes);
    extractReactRouterRoutes(tree.rootNode, routes);
    extractNestjsRoutes(tree.rootNode, routes);
    extractVueRouterRoutes(tree.rootNode, routes);
    return routes;
  },
};
