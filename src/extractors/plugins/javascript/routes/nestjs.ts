import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";

const HTTP_DECORATORS = new Set([
  "Get",
  "Post",
  "Put",
  "Patch",
  "Delete",
  "All",
  "Head",
  "Options",
]);

/** NestJS-style decorators: @Get("/path"), @Post("/path") */
export function extractNestjsRoutes(root: Node, routes: RouteInfo[]): void {
  walkForDecoratorRoutes(root, routes);
}

function walkForDecoratorRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "decorator") {
    const expr = node.child(1);
    if (expr?.type === "call_expression") {
      const callee = expr.childForFieldName("function");
      const calleeName = callee?.text;

      if (calleeName && HTTP_DECORATORS.has(calleeName)) {
        const args = expr.childForFieldName("arguments");
        let path = "/";
        if (args && args.childCount > 2) {
          const firstArg = args.child(1);
          if (firstArg) path = stripQuotes(firstArg.text);
        }

        const parent = node.parent;
        let handler: string | null = null;
        if (parent) {
          for (let i = 0; i < parent.childCount; i++) {
            const sibling = parent.child(i)!;
            if (sibling.type === "method_definition") {
              handler = sibling.childForFieldName("name")?.text ?? null;
              break;
            }
          }
        }

        routes.push({
          path,
          httpMethod: calleeName.toUpperCase(),
          kind: "api",
          handler,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkForDecoratorRoutes(node.child(i)!, routes);
  }
}
