import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * AngularJS (1.x) route tables: ngRoute's `$routeProvider.when('/garage', { templateUrl:
 * 'views/garage.html', controller: 'GarageController' })` and ui-router's
 * `$stateProvider.state('garage', { url: '/garage', templateUrl: 'views/garage.html' })`.
 *
 * The config may be wrapped (`angularAMD.route({ … })`). The page is the template: `templateUrl` is relative to the document the app runs in, so
 * it is written as an app-root view path (`/views/garage.html`), which core resolves by
 * path suffix. A `templateUrl` computed by a function names the view it returns last (its
 * default). A ui-router state's name is the route's `name` (`ui-sref="garage"`,
 * `$state.go('garage')`).
 */
export function mayDeclareAngularJsRoutes(sourceText: string): boolean {
  return sourceText.includes("$routeProvider") || sourceText.includes("$stateProvider");
}

export function visitAngularJsRoute(node: Node, routes: RouteInfo[]): void {
  if (node.type !== "call_expression") return;
  const callee = node.childForFieldName("function");
  if (callee?.type !== "member_expression") return;
  const method = callee.childForFieldName("property")?.text;
  if (method !== "when" && method !== "state") return;
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  const [first, second] = args;
  // `angularAMD.route({ … })` and similar wrappers hand the config object on.
  const config = second?.type === "call_expression" ? second.childForFieldName("arguments")?.namedChildren[0] : second;
  if (first?.type !== "string" || config?.type !== "object") return;
  const value = (key: string): Node | null => {
    for (const pair of config.namedChildren) {
      if (pair.type !== "pair") continue;
      const k = pair.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "");
      if (k === key) return pair.childForFieldName("value");
    }
    return null;
  };
  const literal = (n: Node | null): string | null => (n?.type === "string" ? n.text.slice(1, -1) : null);
  const name = method === "state" ? first.text.slice(1, -1) : null;
  const path = method === "when" ? first.text.slice(1, -1) : literal(value("url"));
  if (!path || !path.startsWith("/")) return;
  const template = value("templateUrl");
  let view = literal(template);
  if (!view && template && (template.type === "function_expression" || template.type === "arrow_function" || template.type === "function")) {
    const returned = [...template.text.matchAll(/\breturn\s+['"]([^'"]+\.html?)['"]/g)];
    view = returned.length > 0 ? returned[returned.length - 1]![1]! : null;
  }
  const controller = literal(value("controller"));
  routes.push({
    path,
    httpMethod: null,
    kind: "frontend",
    handler: controller ?? name ?? path,
    componentPath: view ? "/" + view.replace(/^\.?\/+/, "") : null,
    ...(name ? { name } : {}),
    calls: [],
    middleware: [],
    line: node.startPosition.row + 1,
  });
}
