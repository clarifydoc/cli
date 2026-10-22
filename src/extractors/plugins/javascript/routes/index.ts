import type { Node, Tree } from "web-tree-sitter";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { visitExpressRoute, applyRouterLevelGuards } from "./express.js";
import { collectRouteArrays, visitReactRouterRoute } from "./react-router.js";
import { visitNestjsRoute } from "./nestjs.js";
import { visitVueRouterRoute } from "./vue-router.js";
import { collectTanstackCodeRoutes, visitTanstackFileRoute } from "./tanstack-router.js";
import { mayDefineTrpc, visitTrpcRouter } from "./trpc.js";
import { collectCdkRoutes } from "./cdk.js";
import { extractGraphqlCodeFirst, mayDefineGraphqlCode } from "./graphql-code-first.js";
import { extractInlineSdlRoutes } from "./graphql-sdl-inline.js";
import { mayDeclareReactNavigation, visitReactNavigationScreen, visitStaticNavigator } from "./react-navigation.js";
import { extractGrpcJsServices } from "./grpc-server.js";

/**
 * JS/TS route extraction: one shared tree walk feeding every supported
 * framework's per-node visitor (instead of four full-tree walks). Each
 * framework collects into its own bucket so the output keeps the fixed
 * framework order the sequential extractors produced.
 */
export const javascriptRouteExtractor: RouteExtractor = {
  languages: ["typescript", "javascript"],

  extractRoutes(tree: Tree, sourceText: string, _filePath?: string, facts?: RouteFact[]): RouteInfo[] {
    const express: RouteInfo[] = [];
    const reactRouter: RouteInfo[] = [];
    const nestjs: RouteInfo[] = [];
    const vueRouter: RouteInfo[] = [];
    const tanstack: RouteInfo[] = [];
    const trpc: RouteInfo[] = [];
    const maybeTrpc = mayDefineTrpc(sourceText);
    const navigation: RouteInfo[] = [];
    const maybeNavigation = mayDeclareReactNavigation(sourceText);
    const maybeTanstack = sourceText.includes("FileRoute(") || sourceText.includes("createRoute(");

    const walk = (node: Node): void => {
      visitExpressRoute(node, express);
      visitReactRouterRoute(node, reactRouter, facts);
      visitNestjsRoute(node, nestjs, facts);
      visitVueRouterRoute(node, vueRouter, facts);
      if (maybeTanstack) visitTanstackFileRoute(node, tanstack);
      if (maybeTrpc) visitTrpcRouter(node, trpc, facts);
      if (maybeNavigation) {
        visitReactNavigationScreen(node, navigation);
        visitStaticNavigator(node, navigation);
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);
    // Express guards declared once on the router (`router.use(requireAuth)`)
    // apply to every later route on it — a file-level fact the per-node
    // visitor cannot see, so it is written after the walk.
    applyRouterLevelGuards(tree.rootNode, express);
    // Route arrays another file may `.map` into <Route> (react-router-resolver.ts).
    if (facts && /\bpath\s*:/.test(sourceText)) collectRouteArrays(tree.rootNode, sourceText, facts);

    if (maybeTanstack) collectTanstackCodeRoutes(tree.rootNode, sourceText, tanstack);
    // AWS CDK stacks: API Gateway routes wired to Lambdas, placed on their handlers by cdkRouteResolver.
    collectCdkRoutes(tree.rootNode, sourceText, facts);

    // Code-first GraphQL schemas (NestJS/TypeGraphQL resolvers, Pothos, Nexus, graphql-js): their root fields.
    const graphql: RouteInfo[] = [];
    if (mayDefineGraphqlCode(sourceText)) extractGraphqlCodeFirst(tree.rootNode, sourceText, graphql);
    // A schema written inline (Apollo `typeDefs = gql\`type Query …\``): the same routes a `.graphql` file gives.
    graphql.push(...extractInlineSdlRoutes(sourceText));

    // grpc-js servers: the handlers `addService` registers per rpc.
    const grpc = extractGrpcJsServices(sourceText);

    return [...express, ...reactRouter, ...nestjs, ...vueRouter, ...tanstack, ...trpc, ...navigation, ...graphql, ...grpc];
  },
};
