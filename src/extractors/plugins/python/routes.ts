import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";
import { HTTP_METHODS } from "../../routes/base.js";
import type { RouteExtractor } from "../../routes/base.js";

/** Python: @app.get("/path") — FastAPI, Flask, Django decorators */
export function extractPythonRoutes(root: Node, routes: RouteInfo[]): void {
  walkForPythonRoutes(root, routes);
  walkForRouterMounts(root, routes);
}

/**
 * FastAPI router mounts: `router.include_router(auth.router, prefix="/users")`.
 *
 * The prefix lives here, in the wiring file, while the endpoints it applies to
 * are decorated in the module being mounted — so on its own this file's routes
 * look prefix-less and several routers' `@router.get("")` all collapse to the
 * same empty path. Emitted in the shape `resolveRouterMounts` already consumes
 * for Express (`kind: "api"`, `httpMethod: null`, `handler` = the identifier to
 * resolve through the import index), which then applies the prefix across files.
 *
 * Only mounts with a LITERAL `prefix=` are emitted. `include_router(x.router)`
 * contributes no prefix, and `prefix=settings.api_prefix` is a value this
 * analysis cannot know; emitting either would leave an unresolvable non-endpoint
 * sitting in the route map, which is worse than the prefix it failed to supply.
 */
function walkForRouterMounts(node: Node, routes: RouteInfo[]): void {
  if (node.type === "call") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "include_router") {
      const args = node.childForFieldName("arguments");
      const router = args ? firstPositionalArg(args) : null;
      const prefix = args ? literalKeywordArg(args, "prefix") : null;
      // `auth.router` → "auth", the name the import index can resolve.
      const handler = router ? rootIdentifier(router) : null;
      if (handler && prefix !== null) {
        routes.push({
          path: prefix,
          httpMethod: null,
          kind: "api",
          handler,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
        });
      }
    }
  }
  for (const child of node.children) walkForRouterMounts(child, routes);
}

/** First non-keyword argument inside an `argument_list`. */
function firstPositionalArg(args: Node): Node | null {
  for (const child of args.namedChildren) {
    if (child.type !== "keyword_argument") return child;
  }
  return null;
}

/** Value of `name="literal"` in an argument list, or null if absent/non-literal. */
function literalKeywordArg(args: Node, name: string): string | null {
  for (const child of args.namedChildren) {
    if (child.type !== "keyword_argument") continue;
    if (child.childForFieldName("name")?.text !== name) continue;
    const value = child.childForFieldName("value");
    if (value?.type !== "string") return null;
    return stripQuotes(value.text);
  }
  return null;
}

/** Root identifier of an attribute chain: `auth.router` → "auth"; `x` → "x". */
function rootIdentifier(node: Node): string | null {
  let current: Node | null = node;
  while (current && current.type === "attribute") current = current.childForFieldName("object");
  return current?.type === "identifier" ? current.text : null;
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
