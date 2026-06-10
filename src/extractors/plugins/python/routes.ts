import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";
import { HTTP_METHODS } from "../../routes/base.js";
import type { RouteExtractor } from "../../routes/base.js";

/** Python: @app.get("/path") — FastAPI, Flask, Django decorators */
export function extractPythonRoutes(root: Node, routes: RouteInfo[]): void {
  walkForPythonRoutes(root, routes);
}

function walkForPythonRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "decorated_definition") {
    for (const child of node.children) {
      if (child.type === "decorator") {
        const call = child.child(1);
        if (call?.type === "call") {
          const fn = call.childForFieldName("function");
          if (fn?.type === "attribute") {
            const method = fn.childForFieldName("attribute")?.text;
            if (method && HTTP_METHODS.has(method.toLowerCase())) {
              const args = call.childForFieldName("arguments");
              let path = "/";
              if (args && args.childCount > 1) {
                const firstArg = args.child(1);
                if (firstArg) path = stripQuotes(firstArg.text);
              }

              let handler: string | null = null;
              for (const def of node.children) {
                if (def.type === "function_definition") {
                  handler = def.childForFieldName("name")?.text ?? null;
                }
              }

              routes.push({
                path,
                httpMethod: method.toUpperCase(),
                kind: "api",
                handler,
                calls: [],
                middleware: [],
                line: node.startPosition.row + 1,
              });
            }
          }
        }
      }
    }
  }

  for (const child of node.children) {
    walkForPythonRoutes(child, routes);
  }
}

/** Route-registry adapter for this plugin (see routes/base.ts). */
export const pythonRouteExtractor: RouteExtractor = {
  languages: ["python"],
  extractRoutes(tree, _sourceText) {
    const routes: RouteInfo[] = [];
    extractPythonRoutes(tree.rootNode, routes);
    return routes;
  },
};
