import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";
import { HTTP_METHODS } from "../../routes/base.js";

/** Python: @app.get("/path") — FastAPI, Flask, Django decorators */
export function extractPythonRoutes(root: Node, routes: RouteInfo[]): void {
  walkForPythonRoutes(root, routes);
}

function walkForPythonRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "decorated_definition") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
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
              for (let j = 0; j < node.childCount; j++) {
                const def = node.child(j)!;
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

  for (let i = 0; i < node.childCount; i++) {
    walkForPythonRoutes(node.child(i)!, routes);
  }
}
