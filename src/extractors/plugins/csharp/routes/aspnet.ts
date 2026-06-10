import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import type { RouteExtractor } from "../../../routes/base.js";

const CSHARP_HTTP_ATTRIBUTES = new Set([
  "HttpGet",
  "HttpPost",
  "HttpPut",
  "HttpPatch",
  "HttpDelete",
  "HttpHead",
  "HttpOptions",
]);

/** C#: [HttpGet("path")], [Route("path")] — ASP.NET controller routes */
export function extractAspnetRoutes(root: Node, routes: RouteInfo[]): void {
  walkForCsharpRoutes(root, routes);
}

function walkForCsharpRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "method_declaration") {
    const methodName = node.childForFieldName("name")?.text ?? null;

    for (const child of node.children) {
      if (child.type === "attribute_list") {
        for (const attr of child.children) {
          if (attr.type === "attribute") {
            const attrName = attr.childForFieldName("name")?.text ?? "";
            if (CSHARP_HTTP_ATTRIBUTES.has(attrName)) {
              let path = "/";
              const argList = attr.childForFieldName("arguments");
              if (argList && argList.childCount > 1) {
                const firstArg = argList.child(1);
                if (firstArg) path = stripQuotes(firstArg.text);
              }

              routes.push({
                path,
                httpMethod: attrName.replace("Http", "").toUpperCase(),
                kind: "api",
                handler: methodName,
                calls: [],
                middleware: [],
                line: attr.startPosition.row + 1,
              });
            }
          }
        }
      }
    }
  }

  for (const child of node.children) {
    walkForCsharpRoutes(child, routes);
  }
}

/** Route-registry adapter for this plugin (see routes/base.ts). */
export const csharpRouteExtractor: RouteExtractor = {
  languages: ["csharp"],
  extractRoutes(tree, _sourceText) {
    const routes: RouteInfo[] = [];
    extractAspnetRoutes(tree.rootNode, routes);
    return routes;
  },
};
