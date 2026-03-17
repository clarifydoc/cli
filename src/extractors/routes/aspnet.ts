import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../types/analysis.js";
import { stripQuotes } from "../node-helpers.js";

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

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "attribute_list") {
        for (let j = 0; j < child.childCount; j++) {
          const attr = child.child(j)!;
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

  for (let i = 0; i < node.childCount; i++) {
    walkForCsharpRoutes(node.child(i)!, routes);
  }
}
