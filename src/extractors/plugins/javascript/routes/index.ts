import { extractAdonisChains, mayDeclareAdonisRoutes } from "./adonis.js";
import { collectScreenTables } from "./screen-tables.js";
import { staticMountFacts } from "../../shared/static-mounts.js";
import type { Node, Tree } from "web-tree-sitter";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { visitExpressRoute, applyRouterLevelGuards } from "./express.js";
import { collectPathHelperCalls } from "./path-helpers.js";
import { collectRouteArrays, resolveRouteWrappers, visitReactRouterRoute } from "./react-router.js";
import { collectNestClassGuards, visitNestjsRoute } from "./nestjs.js";
import { visitVueRouterRoute } from "./vue-router.js";
import { mayDeclareAngularJsRoutes, visitAngularJsRoute } from "./angularjs.js";
import { collectTanstackCodeRoutes, visitTanstackFileRoute } from "./tanstack-router.js";
import { mayDefineTrpc, visitTrpcRouter } from "./trpc.js";
import { convexCustomBuilders, convexExportedBuilders, relativeImportNames, stringConstants, convexModulePath, mayDefineConvex, visitConvexFunction, visitConvexHttpRoute } from "./convex.js";
import { thriftHandlerFacts } from "../../shared/thrift-handlers.js";
import { collectCdkRoutes } from "./cdk.js";
import { extractGraphqlCodeFirst, mayDefineGraphqlCode } from "./graphql-code-first.js";
import { extractInlineSdlRoutes } from "./graphql-sdl-inline.js";
import { mayDeclareReactNavigation, visitReactNavigationScreen, visitStaticNavigator } from "./react-navigation.js";
import { extractGrpcJsServices } from "./grpc-server.js";
import { contractMembersAt } from "../contract-handlers.js";
import { mayDeclareAzureFunctions, visitAzureFunction } from "./azure-functions.js";
import { extractNodeHttpRoutes, mayDispatchByHand } from "./node-http.js";
import { applyPrefixScopes, collectPluginPrefixes, mayDeclareRouteObjects, mayRegisterPlugins, visitRouteObjects } from "./fastify-hapi.js";

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
    const routeObjects: RouteInfo[] = [];
    const maybeRouteObjects = mayDeclareRouteObjects(sourceText);
    const maybeAzure = mayDeclareAzureFunctions(sourceText);
    const reactRouter: RouteInfo[] = [];
    const nestjs: RouteInfo[] = [];
    const vueRouter: RouteInfo[] = [];
    const tanstack: RouteInfo[] = [];
    const trpc: RouteInfo[] = [];
    const maybeTrpc = mayDefineTrpc(sourceText);
    const convex: RouteInfo[] = [];
    // Convex: exported query/mutation/action builders of a functions-directory module, and `http.route` on its router.
    // A module may also only USE a builder imported from a sibling (`convex/lib/auth.ts`), without naming the generated server.
    const inConvexDir = !!_filePath && /(?:^|\/)convex\//.test(_filePath.replace(/\\/g, "/"));
    const convexModule = (mayDefineConvex(sourceText) || (inConvexDir && /\bimport\b[^;]*from\s*["']\.{1,2}\//.test(sourceText))) && _filePath ? convexModulePath(_filePath, sourceText) : null;
    const convexCustom = convexModule !== null ? convexCustomBuilders(sourceText) : null;
    const convexImported = convexModule !== null && facts ? relativeImportNames(sourceText) : undefined;
    const convexHttp = mayDefineConvex(sourceText) && sourceText.includes("httpRouter");
    const convexConsts = convexHttp ? stringConstants(sourceText) : undefined;
    if (facts && mayDefineConvex(sourceText)) {
      for (const b of convexExportedBuilders(sourceText)) facts.push({ kind: "convex-builder", line: 1, data: b });
    }
    const navigation: RouteInfo[] = [];
    const maybeNavigation = mayDeclareReactNavigation(sourceText);
    const maybeTanstack = sourceText.includes("FileRoute(") || sourceText.includes("createRoute(");
    const maybeAngularJs = mayDeclareAngularJsRoutes(sourceText);

    const walk = (node: Node): void => {
      visitExpressRoute(node, express);
      if (maybeRouteObjects) visitRouteObjects(node, routeObjects);
      if (maybeAzure) visitAzureFunction(node, routeObjects);
      visitReactRouterRoute(node, reactRouter, facts);
      visitNestjsRoute(node, nestjs, facts);
      visitVueRouterRoute(node, vueRouter, facts);
      if (maybeAngularJs) visitAngularJsRoute(node, vueRouter);
      if (maybeTanstack) visitTanstackFileRoute(node, tanstack);
      if (maybeTrpc) visitTrpcRouter(node, trpc, facts);
      if (convexModule !== null) visitConvexFunction(node, convex, convexModule, convexCustom!, convexImported, facts);
      if (convexHttp) visitConvexHttpRoute(node, convex, convexConsts);
      if (maybeNavigation) {
        visitReactNavigationScreen(node, navigation);
        visitStaticNavigator(node, navigation);
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);
    // `element={<PlanRoute />}` where PlanRoute is a small component of this file: what it renders.
    if (reactRouter.length > 0) resolveRouteWrappers(tree.rootNode, reactRouter);
    // Express guards declared once on the router (`router.use(requireAuth)`)
    // apply to every later route on it — a file-level fact the per-node
    // visitor cannot see, so it is written after the walk.
    if (mayDeclareAdonisRoutes(sourceText)) extractAdonisChains(tree.rootNode, express);
    applyRouterLevelGuards(tree.rootNode, express, sourceText, facts);
    // Calls handing a router and a path to a helper that registers the route (path-helpers.ts).
    if (facts) collectPathHelperCalls(tree.rootNode, sourceText, facts);
    // Fastify / hapi plugins registered under a prefix: inline ones prefix their routes here,
    // imported ones become mounts for the project mount pass.
    if (mayRegisterPlugins(sourceText)) {
      const scopes = collectPluginPrefixes(tree.rootNode, routeObjects);
      applyPrefixScopes(scopes, express);
      applyPrefixScopes(scopes, routeObjects);
    }
    // Route arrays another file may `.map` into <Route> (react-router-resolver.ts).
    if (facts && (/\bpath\s*:/.test(sourceText) || sourceText.includes("Object.entries("))) collectRouteArrays(tree.rootNode, sourceText, facts);
    // A hand-rolled router's `{ path, screen }` table, joined to the layout showing each screen (screen-tables.ts).
    if (facts) collectScreenTables(tree.rootNode, sourceText, facts);
    // A NestJS controller's guard on a base class in another file (shared/class-guards.ts).
    if (facts && /\bextends\b|@UseGuards\b/.test(sourceText) && (nestjs.length > 0 || /@(?:UseGuards|Roles|Public)\b/.test(sourceText))) collectNestClassGuards(tree.rootNode, nestjs, facts);

    if (maybeTanstack) collectTanstackCodeRoutes(tree.rootNode, sourceText, tanstack);
    // AWS CDK stacks: API Gateway routes wired to Lambdas, placed on their handlers by cdkRouteResolver.
    collectCdkRoutes(tree.rootNode, sourceText, facts);
    // `app.use(express.static(path.join(here, "public")))`: the pages there are served from the mount.
    if (facts) facts.push(...staticMountFacts(sourceText));

    // Code-first GraphQL schemas (NestJS/TypeGraphQL resolvers, Pothos, Nexus, graphql-js): their root fields.
    const graphql: RouteInfo[] = [];
    if (mayDefineGraphqlCode(sourceText)) extractGraphqlCodeFirst(tree.rootNode, sourceText, graphql);
    // A schema written inline (Apollo `typeDefs = gql\`type Query …\``): the same routes a `.graphql` file gives.
    graphql.push(...extractInlineSdlRoutes(sourceText));

    // A raw `http.createServer` listener dispatching by hand on the path.
    if (mayDispatchByHand(sourceText)) extractNodeHttpRoutes(tree.rootNode, routeObjects);

    // grpc-js servers: the handlers `addService` registers per rpc.
    const grpc = extractGrpcJsServices(sourceText, tree);
    if (facts) facts.push(...thriftHandlerFacts(sourceText, "js", (offset) => contractMembersAt(tree, sourceText, offset)));

    return [...express, ...routeObjects, ...reactRouter, ...nestjs, ...vueRouter, ...tanstack, ...trpc, ...convex, ...navigation, ...graphql, ...grpc];
  },
};
