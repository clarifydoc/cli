import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../types/analysis.js";
import { stripQuotes } from "../node-helpers.js";

/** Vue Router: routes array config { path: "/foo", component: Bar } */
export function extractVueRouterRoutes(root: Node, routes: RouteInfo[]): void {
  walkForVueRouterConfig(root, routes);
}

function walkForVueRouterConfig(node: Node, routes: RouteInfo[]) {
  if (node.type === "object") {
    let path: string | null = null;
    let handler: string | null = null;

    for (let i = 0; i < node.childCount; i++) {
      const prop = node.child(i)!;
      if (prop.type === "pair" || prop.type === "property_assignment") {
        const key = prop.childForFieldName("key");
        const value = prop.childForFieldName("value");
        const keyText = key?.text;

        if (keyText === "path" && value) {
          path = stripQuotes(value.text);
        } else if (
          (keyText === "component" || keyText === "name") &&
          value
        ) {
          handler = value.text;
        }
      }
    }

    if (path !== null) {
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

  for (let i = 0; i < node.childCount; i++) {
    walkForVueRouterConfig(node.child(i)!, routes);
  }
}
