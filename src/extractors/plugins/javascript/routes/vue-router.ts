import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";

/** Vue Router: routes array config { path: "/foo", component: Bar } */
export function extractVueRouterRoutes(root: Node, routes: RouteInfo[]): void {
  walkForVueRouterConfig(root, routes);
}

function walkForVueRouterConfig(node: Node, routes: RouteInfo[]) {
  visitVueRouterRoute(node, routes);
  for (const child of node.children) {
    walkForVueRouterConfig(child, routes);
  }
}

/**
 * Route-config keys that distinguish a router entry from an arbitrary object
 * that merely HAS a `path` property. Data arrays are full of the latter —
 * category descriptors (`{ text: "Vegetables", path: "Vegetables", image }`),
 * sidebar link lists (`{ name, path, icon }`) — and each one became a phantom
 * frontend route. A real Vue Router record renders/forwards something, so it
 * carries at least one of these.
 */
const ROUTE_CONFIG_KEYS = new Set(["component", "components", "children", "redirect", "beforeEnter"]);

/** Inspect a single node for a Vue Router route config object. */
export function visitVueRouterRoute(node: Node, routes: RouteInfo[]): void {
  if (node.type === "object") {
    let path: string | null = null;
    let handler: string | null = null;
    let componentPath: string | null = null;
    let isRouteConfig = false;

    for (const prop of node.children) {
      if (prop.type === "pair" || prop.type === "property_assignment") {
        const key = prop.childForFieldName("key");
        const value = prop.childForFieldName("value");
        const keyText = key?.text;

        if (keyText && ROUTE_CONFIG_KEYS.has(keyText)) isRouteConfig = true;
        if (keyText === "path" && value) {
          path = stripQuotes(value.text);
        } else if (keyText === "component" && value) {
          handler = componentHandler(value);
          componentPath = componentSpecifier(value);
        } else if (keyText === "name" && value && handler === null) {
          // Fall back to the route `name` for display only when no component
          // has set the handler yet — `component` is the stronger signal.
          handler = stripQuotes(value.text);
        }
      }
    }

    if (path !== null && isRouteConfig) {
      routes.push({
        path,
        httpMethod: null,
        kind: "frontend",
        handler,
        componentPath,
        calls: [],
        middleware: [],
        line: node.startPosition.row + 1,
      });
    }
  }
}

/**
 * The `component` value of a route. A lazy-loaded component
 * (`() => import("./main.vue")`, or wrapped in `defineAsyncComponent`) carries
 * the target module rather than an identifier — surface the module's base name
 * (e.g. "main") so the route reads cleanly instead of showing the raw arrow.
 */
function componentHandler(value: Node): string {
  const lazy = value.text.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
  if (lazy) {
    return lazy[1].split("/").pop()!.replace(/\.\w+$/, "");
  }
  return value.text;
}

/**
 * The module specifier the route's `component` resolves to, so the screen
 * builder can follow the route to the real page file:
 *   - lazy import (`() => import("./pak.vue")`) → "./pak.vue"
 *   - bare identifier (`component: Pak` for a statically-imported component)
 *     → "Pak" (resolved later against the file's imports)
 * Returns null for inline/anonymous components with no traceable target.
 */
function componentSpecifier(value: Node): string | null {
  const lazy = value.text.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
  if (lazy) return lazy[1];
  if (value.type === "identifier") return value.text;
  return null;
}
