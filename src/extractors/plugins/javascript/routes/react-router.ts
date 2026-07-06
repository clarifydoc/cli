import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { joinRoutePath } from "../../../shared/route-paths.js";

/** React Router: <Route path="/dashboard" component={X} /> */
export function extractReactRouterRoutes(root: Node, routes: RouteInfo[]): void {
  walkForJsxRoutes(root, routes);
}

function walkForJsxRoutes(node: Node, routes: RouteInfo[]) {
  visitReactRouterRoute(node, routes);
  for (const child of node.children) {
    walkForJsxRoutes(child, routes);
  }
}

/** Inspect a single node for a React Router `<Route …>` element. */
export function visitReactRouterRoute(node: Node, routes: RouteInfo[]): void {
  if (
    node.type === "jsx_opening_element" ||
    node.type === "jsx_self_closing_element"
  ) {
    const nameNode = node.childForFieldName("name") ?? node.child(1);
    if (nameNode?.text === "Route") {
      let path = routeAttr(node, "path");
      const handlerRaw = routeAttrRaw(node, "component") ?? routeAttrRaw(node, "element");
      const handler = handlerRaw != null ? handlerRaw.replace(/[{}< />]/g, "").trim() : null;

      if (path) {
        // Nested <Route> composition: a child of <Route path="/seller"> with
        // path="product-list" matches /seller/product-list — the bare child
        // path never joins an api-call or screen on its own. A child written
        // ABSOLUTE (leading "/") already carries the full path in react-router
        // v6, so it passes through untouched.
        if (!path.startsWith("/")) {
          const prefix = ancestorRoutePrefix(node);
          if (prefix) path = joinRoutePath(prefix, path);
        }
        routes.push({
          path,
          httpMethod: null,
          kind: "frontend",
          handler,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}

/** The raw value text of a named attribute on a JSX opening element. */
function routeAttrRaw(openingEl: Node, name: string): string | null {
  for (const attr of openingEl.children) {
    if (attr.type !== "jsx_attribute") continue;
    const attrName = attr.childForFieldName("name")?.text ?? attr.child(0)?.text;
    if (attrName === name) {
      return attr.child(2)?.text ?? null;
    }
  }
  return null;
}

/** The string value of a named attribute on a JSX opening element, unquoted. */
function routeAttr(openingEl: Node, name: string): string | null {
  const raw = routeAttrRaw(openingEl, name);
  return raw != null ? stripQuotes(raw) : null;
}

/**
 * Accumulated path of every ancestor `<Route path=…>` wrapping this one,
 * outermost first (`/seller` for a route nested under <Route path="/seller">).
 * Climbs the JSX element chain — the fused route walk is stateless per node,
 * so parent context is recovered from the tree, not carried on a stack.
 */
function ancestorRoutePrefix(openingEl: Node): string | null {
  const segments: string[] = [];
  // A self-closing <Route .../> hangs DIRECTLY under the enclosing
  // jsx_element; a paired <Route>…</Route> has its own jsx_element wrapper
  // first. Walk from .parent and skip only the element this opener belongs to.
  let n: Node | null = openingEl.parent ?? null;
  while (n) {
    if (n.type === "jsx_element") {
      const opener = n.child(0);
      if (opener && opener.id !== openingEl.id && opener.type === "jsx_opening_element") {
        const tag = opener.childForFieldName("name") ?? opener.child(1);
        if (tag?.text === "Route") {
          const p = routeAttr(opener, "path");
          if (p) {
            segments.unshift(p);
            // An absolute ancestor is the composition root — stop climbing.
            if (p.startsWith("/")) break;
          }
        }
      }
    }
    n = n.parent;
  }
  return segments.length > 0 ? segments.reduce((acc, s) => joinRoutePath(acc, s)) : null;
}
