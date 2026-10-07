import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import type { RouteExtractor } from "../../routes/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { assignment, callArgs, callName, leafOf, stringValue } from "./syntax.js";

const VERB = /^@(get|post|put|delete|patch|head|options|use)\s+(\S+)/i;
const PROGRAMMATIC = /^pr_(get|post|put|delete|patch|head)$/;

/** Plumber's `/users/<id>` / `<id:int>` → `/users/{id}`. */
function plumberPath(path: string): string {
  return path.replace(/<([A-Za-z_.][\w.]*)(?::\w+)?>/g, "{$1}");
}

/**
 * Plumber routes:
 *  - annotations: the `#*` (or `#'`) comment block right above a function —
 *    `#* @get /api/orders`, `#* @param status:str` — routes that function;
 *    an anonymous one is the route's own handler (its calls are the route's);
 *  - the programmatic API: `pr_get(pr, "/x", handler)` (also piped
 *    `pr() %>% pr_get("/x", function() …)`) and `pr$handle("GET", "/x", h)`.
 */
export const rRouteExtractor: RouteExtractor = {
  languages: ["r"],
  extractRoutes(tree: Tree, sourceText: string): RouteInfo[] {
    if (!/@(?:get|post|put|delete|patch|head|options|use)\b|\bpr_(?:get|post|put|delete|patch|head)\b|\$handle\s*\(/.test(sourceText)) return [];
    const routes: RouteInfo[] = [];
    const nodes = tree.rootNode.namedChildren;

    nodes.forEach((node, i) => {
      const bound = assignment(node);
      const def = node.type === "function_definition" ? node : bound?.value.type === "function_definition" ? bound.value : null;
      if (!def) return;
      // The comment block directly above (no blank-line gap needed: comments are siblings).
      const block: string[] = [];
      for (let j = i - 1; j >= 0 && nodes[j]!.type === "comment"; j--) {
        const text = nodes[j]!.text.replace(/^#['*]\s?/, "");
        if (!/^#['*]/.test(nodes[j]!.text)) break;
        block.unshift(text);
      }
      const verbs = block.map((l) => VERB.exec(l.trim())).filter((m): m is RegExpExecArray => m !== null);
      if (verbs.length === 0) return;
      const declared = block
        .map((l) => /^@param\s+([A-Za-z_.][\w.]*)(?::(\w+))?/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => m !== null);
      for (const v of verbs) {
        const method = v[1]!.toUpperCase();
        const path = plumberPath(v[2]!);
        const inPath = new Set([...v[2]!.matchAll(/<([A-Za-z_.][\w.]*)/g)].map((m) => m[1]!));
        const params: RouteParamInfo[] = declared.map((d) => ({
          name: d[1]!,
          type: d[2] ?? null,
          binding: inPath.has(d[1]!) ? "route" : method === "GET" || method === "DELETE" ? "query" : "body",
        }));
        const route: RouteInfo = {
          path,
          httpMethod: method === "USE" ? null : method,
          kind: "api",
          handler: bound?.name ?? null,
          calls: bound ? [] : extractCalls(def.childForFieldName("body"), "r"),
          middleware: [],
          line: node.startPosition.row + 1,
        };
        if (params.length > 0) route.params = params;
        routes.push(route);
      }
    });

    for (const call of tree.rootNode.descendantsOfType("call")) {
      const name = callName(call);
      if (!name) continue;
      const args = callArgs(call);
      const leaf = leafOf(name);
      let method: string | null = null;
      let pathArg: Node | null | undefined;
      if (PROGRAMMATIC.test(leaf)) {
        method = PROGRAMMATIC.exec(leaf)![1]!.toUpperCase();
        pathArg = args.find((a) => (a.name === null || a.name === "path") && stringValue(a.value) !== null)?.value;
      } else if (leaf === "handle" && name.includes(".")) {
        method = stringValue(args[0]?.value)?.toUpperCase() ?? null;
        pathArg = args[1]?.value;
      }
      const path = stringValue(pathArg);
      if (!method || path === null) continue;
      const handler = args.find((a) => a.value && (a.value.type === "identifier" || a.value.type === "function_definition") && a.value !== pathArg && a.name !== "pr")?.value;
      routes.push({
        path: plumberPath(path),
        httpMethod: method,
        kind: "api",
        handler: handler?.type === "identifier" ? handler.text : null,
        calls: handler?.type === "function_definition" ? extractCalls(handler.childForFieldName("body"), "r") : [],
        middleware: [],
        line: call.startPosition.row + 1,
      });
    }
    return routes;
  },
};
