import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { HTTP_METHODS, collectCallNames } from "../../../routes/base.js";

/** Express-style: app.get("/path", handler) */
export function extractExpressRoutes(root: Node, routes: RouteInfo[]): void {
  walkForRoutes(root, routes);
}

function walkForRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "member_expression") {
      const prop = fn.childForFieldName("property");
      const method = prop?.text?.toLowerCase();

      if (method && HTTP_METHODS.has(method)) {
        const args = node.childForFieldName("arguments");
        if (args) {
          const firstArg = args.child(1); // skip '('
          if (firstArg && (firstArg.type === "string" || firstArg.type === "template_string")) {
            const path = stripQuotes(firstArg.text);
            let handler: string | null = null;
            const middleware: string[] = [];
            for (let i = 2; i < args.childCount - 1; i++) {
              const arg = args.child(i)!;
              if (arg.type === "," || arg.type === "(") continue;
              if (arg.type === "identifier" || arg.type === "member_expression") {
                if (handler) middleware.push(handler);
                handler = arg.text;
              }
            }

            let calls: string[] = [];
            const lastArg = args.child(args.childCount - 2);
            if (
              lastArg &&
              (lastArg.type === "arrow_function" ||
                lastArg.type === "function_expression" ||
                lastArg.type === "function")
            ) {
              calls = collectCallNames(lastArg);
            }

            routes.push({
              path,
              httpMethod: method === "use" ? null : method.toUpperCase(),
              kind: "api",
              handler,
              calls,
              middleware,
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkForRoutes(node.child(i)!, routes);
  }
}
