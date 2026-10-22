import type { Tree } from "web-tree-sitter";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { LARAVEL_ROUTES_FACT, codeigniterRouteExtractor } from "./codeigniter.js";
import { extractLaravelRoutes } from "./laravel.js";
import { extractSymfonyAttributeRoutes } from "./symfony.js";
import { SLIM_GATE, extractSlimRoutes } from "./slim.js";

/**
 * PHP route extraction — one extractor covering the supported frameworks:
 *   - Laravel: `Route::` facade declarations (gated on the substring so
 *     non-Laravel files skip the tree walk entirely);
 *   - Symfony: PHP-8 `#[Route]` / verb attributes (gated likewise);
 *   - Slim (and Lumen's `$router`): `$app->get('/x', …)` registrations and `group()` prefixes;
 *   - CodeIgniter: convention routing from `controllers/<dir>/<file>.php`
 *     (path-gated inside the extractor itself).
 */
export const phpRouteExtractor: RouteExtractor = {
  languages: ["php"],

  extractRoutes(tree: Tree, sourceText: string, filePath?: string, facts?: RouteFact[]): RouteInfo[] {
    const routes: RouteInfo[] = [];
    if (sourceText.includes("Route::")) {
      // Laravel mounts routes/api.php under /api by convention — the prefix
      // is framework config, never written in the file.
      const isApiFile = /(^|[/\\])routes[/\\]api\.php$/i.test(filePath ?? "");
      extractLaravelRoutes(tree.rootNode, routes, isApiFile ? "api" : "");
      // A project routed by the facade does not route by CodeIgniter's convention.
      if (routes.length > 0) facts?.push({ kind: LARAVEL_ROUTES_FACT, line: routes[0]!.line, data: null });
    }
    if (/#\[\s*(?:[\w\\]+\\)?(Route|Get|Post|Put|Patch|Delete)\b/.test(sourceText)) {
      extractSymfonyAttributeRoutes(tree.rootNode, routes);
    }
    if (SLIM_GATE.test(sourceText)) extractSlimRoutes(tree.rootNode, routes);
    routes.push(...codeigniterRouteExtractor.extractRoutes(tree, sourceText, filePath, facts));
    return routes;
  },
};
