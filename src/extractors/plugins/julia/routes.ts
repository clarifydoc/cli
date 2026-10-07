import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo } from "../../../types/analysis.js";
import type { RouteExtractor } from "../../routes/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { calleeName, stringValue } from "./syntax.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Genie's `/users/:id::Int` and Oxygen's `/users/{id}` → `/users/{id}`. */
function juliaPath(path: string): string {
  return path.replace(/:(\w+)(?:::\w+)?/g, "{$1}");
}

/**
 * Julia web routes:
 *  - Genie: `route("/x") do … end`, `route("/x", method = POST) do … end`,
 *    `route("/x", handler, method = GET)`;
 *  - Oxygen: `@get "/x" function(req) … end`, `@post "/x" handler`,
 *    `@route ["GET", "POST"] "/x" handler`;
 *  - HTTP.jl: `HTTP.register!(router, "GET", "/x", handler)`.
 * A `do` block or anonymous function is the route's own handler (its calls
 * are the route's); a named one is the handler.
 */
export const juliaRouteExtractor: RouteExtractor = {
  languages: ["julia"],
  extractRoutes(tree: Tree, sourceText: string): RouteInfo[] {
    if (!/\broute\s*\(|@(?:get|post|put|patch|delete|route)\b|register!\s*\(/.test(sourceText)) return [];
    const routes: RouteInfo[] = [];
    const push = (at: Node, method: string | null, path: string, handler: Node | null | undefined) => {
      const named = handler && (handler.type === "identifier" || handler.type === "field_expression") ? calleeName(handler) : null;
      const body = handler && !named ? handler : null;
      routes.push({
        path: juliaPath(path),
        httpMethod: method,
        kind: "api",
        handler: named,
        calls: body ? extractCalls(body, "julia") : [],
        middleware: [],
        line: at.startPosition.row + 1,
      });
    };
    for (const node of tree.rootNode.descendantsOfType(["call_expression", "macrocall_expression"])) {
      if (node.type === "call_expression") {
        const name = calleeName(node.namedChildren[0]);
        const args = node.namedChildren.find((c) => c.type === "argument_list")?.namedChildren ?? [];
        if (name === "route" || name === "Genie.Router.route") {
          const path = stringValue(args[0]);
          if (path === null) continue;
          const method = args.find((a) => a.type === "named_argument" && a.namedChildren[0]?.text === "method")?.namedChildren.pop()?.text.replace(/^.*\./, "") ?? "GET";
          const handler = node.namedChildren.find((c) => c.type === "do_clause") ?? args.find((a, i) => i > 0 && a.type !== "named_argument");
          push(node, METHODS.has(method) ? method : null, path, handler);
        } else if (name && /(?:^|\.)register!$/.test(name)) {
          const method = stringValue(args[1])?.toUpperCase() ?? null;
          const path = stringValue(args[2]);
          if (path !== null) push(node, method && METHODS.has(method) ? method : null, path, args[3]);
        }
        continue;
      }
      const macro = node.namedChildren.find((c) => c.type === "macro_identifier")?.text.replace(/^@/, "");
      const margs = node.namedChildren.find((c) => c.type === "macro_argument_list")?.namedChildren ?? [];
      if (!macro) continue;
      if (METHODS.has(macro.toUpperCase()) && macro === macro.toLowerCase()) {
        const path = stringValue(margs[0]);
        if (path !== null) push(node, macro.toUpperCase(), path, margs[1]);
      } else if (macro === "route") {
        const methods = margs[0]?.type === "vector_expression" ? margs[0].namedChildren.map((m) => stringValue(m)?.toUpperCase()).filter((m): m is string => !!m) : [];
        const path = stringValue(margs[1]);
        if (path !== null) for (const m of methods.length ? methods : [null]) push(node, m, path, margs[2]);
      }
    }
    return routes;
  },
};
