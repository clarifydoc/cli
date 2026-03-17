import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../types/analysis.js";
import { stripQuotes } from "../node-helpers.js";

/** React Router: <Route path="/dashboard" component={X} /> */
export function extractReactRouterRoutes(root: Node, routes: RouteInfo[]): void {
  walkForJsxRoutes(root, routes);
}

function walkForJsxRoutes(node: Node, routes: RouteInfo[]) {
  if (
    node.type === "jsx_opening_element" ||
    node.type === "jsx_self_closing_element"
  ) {
    const nameNode = node.childForFieldName("name") ?? node.child(1);
    if (nameNode?.text === "Route") {
      let path: string | null = null;
      let handler: string | null = null;

      for (let i = 0; i < node.childCount; i++) {
        const attr = node.child(i)!;
        if (attr.type === "jsx_attribute") {
          const attrName = attr.childForFieldName("name")?.text ?? attr.child(0)?.text;
          const attrValue = attr.child(2);
          if (attrName === "path" && attrValue) {
            path = stripQuotes(attrValue.text);
          } else if (
            (attrName === "component" || attrName === "element") &&
            attrValue
          ) {
            handler = attrValue.text.replace(/[{}< />]/g, "").trim();
          }
        }
      }

      if (path) {
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

  for (let i = 0; i < node.childCount; i++) {
    walkForJsxRoutes(node.child(i)!, routes);
  }
}
