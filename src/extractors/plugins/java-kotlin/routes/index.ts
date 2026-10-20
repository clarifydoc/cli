import type { Tree } from "web-tree-sitter";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { FUNCTIONAL_ROUTER_GATE_RE, extractSpringRoutes, extractSpringRoutesRegex } from "./spring.js";
import { extractJaxrsMicronautRoutes } from "./jaxrs.js";
import { extractKtorRoutes } from "./ktor.js";
import { extractHaloExtensionRoutes } from "./halo.js";
import { collectSecurityRules } from "./security-dsl.js";
import { extractComposeDestinations } from "./compose-nav.js";

/**
 * Java / Kotlin route extraction — Spring (@GetMapping/@RequestMapping),
 * JAX-RS (@Path + @GET markers), Micronaut (@Controller + @Get) and the Ktor
 * routing DSL. Each family is gated on a cheap substring so annotation-free
 * files skip the full-tree walks entirely.
 */
export const javaKotlinRouteExtractor: RouteExtractor = {
  languages: ["java", "kotlin"],

  extractRoutes(tree: Tree, sourceText: string, filePath?: string, facts?: RouteFact[]): RouteInfo[] {
    const routes: RouteInfo[] = [];

    // Annotation routes name a `*Mapping`; functional endpoints build on `route()`.
    if (sourceText.includes("Mapping") || FUNCTIONAL_ROUTER_GATE_RE.test(sourceText)) {
      extractSpringRoutes(tree.rootNode, routes);
      // Recover routes from files the grammar misparsed into a routeless tree.
      if (routes.length === 0) extractSpringRoutesRegex(sourceText, routes);
    }

    // A JAX-RS interface under a client/ package is an OUTBOUND proxy
    // definition (CXF/RESTEasy client), not a served resource — extracting it
    // as a route would invert the call direction.
    const isClientFile = !!filePath && /(^|\/)clients?\//i.test(filePath.replace(/\\/g, "/"));
    if (!isClientFile && /@(Path|Controller)\b/.test(sourceText)) {
      extractJaxrsMicronautRoutes(tree.rootNode, routes);
    }

    // Halo extensions: CRUD routes generated from `@GVK` (see halo.ts).
    extractHaloExtensionRoutes(sourceText, routes);

    // Ktor verbs are maximally generic (`get`), so the DSL walk only runs in
    // files that actually import io.ktor.
    if (sourceText.includes("io.ktor")) {
      extractKtorRoutes(tree.rootNode, routes, facts);
    }

    // Jetpack Compose navigation graphs: their destinations are the app's screens.
    if (sourceText.includes("NavHost") || sourceText.includes("androidx.navigation")) {
      extractComposeDestinations(tree.rootNode, routes);
    }

    // Spring Security's URL rules, applied to every route by springSecurityResolver.
    collectSecurityRules(sourceText, facts);

    return routes;
  },
};
