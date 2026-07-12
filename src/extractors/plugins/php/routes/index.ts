import type { Tree } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { codeigniterRouteExtractor } from "./codeigniter.js";
import { extractLaravelRoutes } from "./laravel.js";

/**
 * PHP route extraction — one extractor covering both supported frameworks:
 *   - Laravel: `Route::` facade declarations (gated on the substring so
 *     non-Laravel files skip the tree walk entirely);
 *   - CodeIgniter: convention routing from `controllers/<dir>/<file>.php`
 *     (path-gated inside the extractor itself).
 */
export const phpRouteExtractor: RouteExtractor = {
  languages: ["php"],

  extractRoutes(tree: Tree, sourceText: string, filePath?: string): RouteInfo[] {
    const routes: RouteInfo[] = [];
    if (sourceText.includes("Route::")) {
      // Laravel mounts routes/api.php under /api by convention — the prefix
      // is framework config, never written in the file.
      const isApiFile = /(^|[/\\])routes[/\\]api\.php$/i.test(filePath ?? "");
      extractLaravelRoutes(tree.rootNode, routes, isApiFile ? "api" : "");
    }
    routes.push(...codeigniterRouteExtractor.extractRoutes(tree, sourceText, filePath));
    return routes;
  },
};
