import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo } from "../../../types/analysis.js";
import type { RouteExtractor } from "../../routes/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { positionalArgs, stringValue, valuePath } from "./syntax.js";

const VERBS: Record<string, string | null> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", head: "HEAD", options: "OPTIONS", any: null, all: null };

/** `/orders/:id` → `/orders/{id}`. */
function ocamlPath(path: string): string {
  return path.replace(/:(\w+)/g, "{$1}");
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  const joined = `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return joined.length > 1 ? joined.replace(/\/+$/, "") : "/";
}

/** The router a call belongs to: `Dream.get` / `get` (under `open Dream`), Opium's `App.get`. */
function routeVerb(fn: string | null): { verb: string | null; scope: boolean } | null {
  if (!fn) return null;
  const m = /^(?:(?:Dream|App|Opium\.App|Router|Opium\.Router)\.)?(get|post|put|patch|delete|head|options|any|all|scope)$/.exec(fn);
  if (!m) return null;
  return m[1] === "scope" ? { verb: null, scope: true } : { verb: VERBS[m[1]!] ?? null, scope: false };
}

/**
 * OCaml web routes:
 *  - Dream: `Dream.router [ Dream.get "/orders/:id" handler; … ]`, nested under
 *    `Dream.scope "/admin" [middleware] [ … ]`;
 *  - Opium: `App.empty |> App.get "/orders/:id" handler |> App.run_command`.
 * A named handler is the route's handler; a `fun req -> …` is its own, and
 * its calls are the route's.
 */
export const ocamlRouteExtractor: RouteExtractor = {
  languages: ["ocaml"],
  extractRoutes(tree: Tree, sourceText: string): RouteInfo[] {
    if (!/\b(?:Dream|App|Opium|router|scope)\b/.test(sourceText)) return [];
    const routes: RouteInfo[] = [];
    for (const app of tree.rootNode.descendantsOfType("application_expression")) {
      const route = routeVerb(valuePath(app.childForFieldName("function")));
      if (!route || route.scope) continue;
      const args = positionalArgs(app);
      const path = stringValue(args[0]);
      // A bare `get "/x"` must be Dream's: a route path is the argument.
      if (path === null || !path.startsWith("/")) continue;
      const handler = args[1];
      const inner = handler?.type === "parenthesized_expression" ? handler.namedChildren[0] : handler;
      const named = inner?.type === "value_path" ? valuePath(inner) : null;
      const body = inner && !named && (inner.type === "fun_expression" || inner.type === "function_expression" || inner.type === "application_expression") ? inner : null;
      routes.push({
        path: ocamlPath(joinPath(scopePrefix(app), path)),
        httpMethod: route.verb,
        kind: "api",
        handler: named,
        // A lambda is a scope of its own to the walk: its body is what runs.
        calls: body ? extractCalls(body.type === "fun_expression" ? body.childForFieldName("body") ?? body : body, "ocaml") : [],
        middleware: [],
        line: app.startPosition.row + 1,
      });
    }
    return routes;
  },
};

/** The prefixes of the `Dream.scope "/p" [...] [ … ]` calls whose route list holds `node`. */
function scopePrefix(node: Node): string {
  let prefix = "";
  for (let p = node.parent; p; p = p.parent) {
    if (p.type !== "application_expression" || !routeVerb(valuePath(p.childForFieldName("function")))?.scope) continue;
    const args = positionalArgs(p);
    const list = args[args.length - 1];
    if (list && list.startIndex <= node.startIndex && node.endIndex <= list.endIndex) prefix = joinPath(stringValue(args[0]) ?? "", prefix || "/");
  }
  return prefix === "/" ? "" : prefix;
}
