import { extractAndroidNavigation } from "./android-nav.js";
import type { Tree } from "web-tree-sitter";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { FUNCTIONAL_ROUTER_GATE_RE, extractSpringRoutes, extractSpringRoutesRegex } from "./spring.js";
import { extractJaxrsMicronautRoutes } from "./jaxrs.js";
import { extractKtorRoutes } from "./ktor.js";
import { extractJavalinSparkRoutes } from "./javalin-spark.js";
import { GRAPHQL_GATE_RE, extractJvmGraphqlRoutes } from "./graphql.js";
import { extractActuatorEndpoints } from "./actuator.js";
import { extractHaloExtensionRoutes } from "./halo.js";
import { collectSecurityRules } from "./security-dsl.js";
import { collectServiceBeans } from "./service-beans.js";
import { extractComposeDestinations } from "./compose-nav.js";

/**
 * Java / Kotlin route extraction — Spring (@GetMapping/@RequestMapping),
 * JAX-RS (@Path + @GET markers), Micronaut (@Controller + @Get), the Ktor
 * routing DSL and Javalin / Spark route calls. Each family is gated on a cheap substring so annotation-free
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
    // A sub-resource may carry verb markers only (`@POST void report(…)`), mounted by a locator elsewhere.
    if (!isClientFile && (/@(Path|Controller)\b/.test(sourceText) || (/\b(?:javax|jakarta)\.ws\.rs\b/.test(sourceText) && /@(?:GET|POST|PUT|DELETE|PATCH)\b/.test(sourceText)))) {
      extractJaxrsMicronautRoutes(tree.rootNode, routes, facts);
    }

    // Halo extensions: CRUD routes generated from `@GVK` (see halo.ts).
    extractHaloExtensionRoutes(sourceText, routes, facts);

    // Spring Boot actuator endpoints the project declares.
    if (sourceText.includes("Endpoint(")) extractActuatorEndpoints(sourceText, routes);

    // Ktor verbs are maximally generic (`get`), so the DSL walk only runs in
    // files that actually import io.ktor.
    if (sourceText.includes("io.ktor")) {
      extractKtorRoutes(tree.rootNode, routes, facts);
    }

    // Javalin and Spark: routes registered by calls (`app.get("/x", ctx -> …)`, ApiBuilder, Spark's static verbs).
    if (sourceText.includes("io.javalin") || sourceText.includes("spark.")) {
      extractJavalinSparkRoutes(tree.rootNode, sourceText, routes);
    }

    // GraphQL controllers (Spring for GraphQL, Netflix DGS): the root fields they serve.
    if (GRAPHQL_GATE_RE.test(sourceText)) extractJvmGraphqlRoutes(tree.rootNode, routes);

    // Activities and fragments a file opens by class (the screen-class pass makes the classes screens).
    routes.push(...extractAndroidNavigation(sourceText));

    // Jetpack Compose navigation graphs: their destinations are the app's screens.
    if (sourceText.includes("NavHost") || sourceText.includes("androidx.navigation")) {
      extractComposeDestinations(tree.rootNode, routes);
    }

    // Spring Security's URL rules, applied to every route by springSecurityResolver.
    collectSecurityRules(sourceText, facts);

    // CXF service beans, whose jar interfaces become contract rows in cxfServiceBeanResolver.
    collectServiceBeans(sourceText, facts);

    // `@GetMapping("${service.prefix}public/user-types")`: the property's value is a prefix
    // the code does not state — the rest is the known tail a caller's URL ends with.
    for (const r of routes) {
      const m = /^\/?(\$\{[^}]+\})\/?/.exec(r.path);
      if (!m || r.prefixUnresolved) continue;
      r.path = `/${r.path.slice(m[0].length)}`.replace(/\/+$/, "") || "/";
      r.prefixUnresolved = `property:${m[1]}`;
    }

    return routes;
  },
};
