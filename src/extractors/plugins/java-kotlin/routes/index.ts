import type { Tree } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { extractSpringRoutes, extractSpringRoutesRegex } from "./spring.js";
import { extractJaxrsMicronautRoutes } from "./jaxrs.js";

/**
 * Java / Kotlin route extraction — Spring (@GetMapping/@RequestMapping),
 * JAX-RS (@Path + @GET markers) and Micronaut (@Controller + @Get). Each
 * family is gated on a cheap substring so annotation-free files skip the
 * full-tree walks entirely.
 */
export const javaKotlinRouteExtractor: RouteExtractor = {
  languages: ["java", "kotlin"],

  extractRoutes(tree: Tree, sourceText: string): RouteInfo[] {
    const routes: RouteInfo[] = [];

    if (sourceText.includes("Mapping")) {
      extractSpringRoutes(tree.rootNode, routes);
      // Recover routes from files the grammar misparsed into a routeless tree.
      if (routes.length === 0) extractSpringRoutesRegex(sourceText, routes);
    }

    if (/@(Path|Controller)\b/.test(sourceText)) {
      extractJaxrsMicronautRoutes(tree.rootNode, routes);
    }

    return routes;
  },
};
