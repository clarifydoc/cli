import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { visitExpressRoute, applyRouterLevelGuards } from "./express.js";
import { visitReactRouterRoute } from "./react-router.js";
import { visitNestjsRoute } from "./nestjs.js";
import { visitVueRouterRoute } from "./vue-router.js";

/**
 * JS/TS route extraction: one shared tree walk feeding every supported
 * framework's per-node visitor (instead of four full-tree walks). Each
 * framework collects into its own bucket so the output keeps the fixed
 * framework order the sequential extractors produced.
 */
export const javascriptRouteExtractor: RouteExtractor = {
  languages: ["typescript", "javascript"],

  extractRoutes(tree: Tree, _sourceText: string): RouteInfo[] {
    const express: RouteInfo[] = [];
    const reactRouter: RouteInfo[] = [];
    const nestjs: RouteInfo[] = [];
    const vueRouter: RouteInfo[] = [];

    const walk = (node: Node): void => {
      visitExpressRoute(node, express);
      visitReactRouterRoute(node, reactRouter);
      visitNestjsRoute(node, nestjs);
      visitVueRouterRoute(node, vueRouter);
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);
    // Express guards declared once on the router (`router.use(requireAuth)`)
    // apply to every later route on it — a file-level fact the per-node
    // visitor cannot see, so it is written after the walk.
    applyRouterLevelGuards(tree.rootNode, express);

    return [...express, ...reactRouter, ...nestjs, ...vueRouter];
  },
};
