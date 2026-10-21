import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { extractCalls } from "../../../shared/call-graph.js";

/**
 * Slim (and the same router API in Lumen's `$router`): routes registered by a
 * call on the application or a group, wherever that call sits — usually in a
 * `return function (App $app) { … }` a bootstrap file includes.
 *
 *   $app->get('/matches/{id}', MatchAction::class);
 *   $app->post('/fixtures', [FixtureController::class, 'create']);
 *   $app->map(['GET', 'POST'], '/table', 'TableController:show');
 *   $app->group('/api', function (RouteCollectorProxy $group) {
 *       $group->get('/clubs', function (Request $request, Response $response) { … });
 *   });
 *
 * A closure handler's calls are the route's own; a `Class::class`, a
 * `[Class::class, 'method']` or a `'Class:method'` string names the handler.
 * A `group()` prefixes every route registered inside its closure.
 */
const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "any", "map"]);

export const SLIM_GATE = /\bSlim\\|RouteCollectorProxy|\$router->(?:get|post|put|patch|delete)\s*\(/;

export function extractSlimRoutes(root: Node, routes: RouteInfo[]): void {
  const walk = (node: Node, prefix: string): void => {
    if (node.type === "member_call_expression") {
      const name = node.childForFieldName("name")?.text ?? "";
      const args = argumentsOf(node);
      if (name === "group" && args.length >= 2) {
        const path = stringOf(args[0]);
        const fn = args[args.length - 1];
        if (path !== null && fn && /function|arrow_function/.test(fn.type)) {
          for (const c of node.children) if (c.type !== "arguments") walk(c, prefix);
          walk(fn, joinPath(prefix, path));
          return;
        }
      }
      if (VERBS.has(name)) {
        const methods = name === "map" ? arrayStrings(args[0]).map((m) => m.toUpperCase()) : name === "any" ? [null] : [name.toUpperCase()];
        const pathArg = name === "map" ? args[1] : args[0];
        const path = stringOf(pathArg);
        const handlerArg = name === "map" ? args[2] : args[1];
        if (path !== null && handlerArg && methods.length > 0) {
          const { handler, body } = handlerOf(handlerArg);
          for (const method of methods) {
            routes.push({
              path: joinPath(prefix, path),
              httpMethod: method,
              kind: "api",
              handler,
              calls: body ? extractCalls(body, "php") : [],
              middleware: [],
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }
    for (const c of node.children) walk(c, prefix);
  };
  walk(root, "");
}

function argumentsOf(call: Node): Node[] {
  const list = call.childForFieldName("arguments") ?? call.children.find((c) => c.type === "arguments");
  return (list?.namedChildren ?? []).filter((a): a is Node => !!a && a.type === "argument").map((a) => a.namedChildren[a.namedChildren.length - 1] ?? a);
}

function stringOf(node: Node | undefined): string | null {
  if (!node || (node.type !== "string" && node.type !== "encapsed_string")) return null;
  const text = node.text.replace(/^['"]|['"]$/g, "");
  return /[$]/.test(text) ? null : text;
}

function arrayStrings(node: Node | undefined): string[] {
  if (node?.type !== "array_creation_expression") return [];
  return node.namedChildren.flatMap((el) => {
    const s = el?.namedChildren.find((c) => c?.type === "string" || c?.type === "encapsed_string");
    const v = stringOf(s ?? undefined);
    return v ? [v] : [];
  });
}

/** The handler a route names, or the closure that is it. */
function handlerOf(node: Node): { handler: string | null; body: Node | null } {
  if (node.type === "anonymous_function" || node.type === "arrow_function") {
    return { handler: null, body: node.childForFieldName("body") ?? node };
  }
  // `MatchAction::class` — an invokable action.
  const constant = /^\\?(?:[\w\\]+\\)?(\w+)::class$/.exec(node.text);
  if (constant) return { handler: `${constant[1]}.__invoke`, body: null };
  // `[MatchController::class, 'show']`
  if (node.type === "array_creation_expression") {
    const parts = node.namedChildren.map((el) => el?.namedChildren[0]?.text ?? "");
    const cls = /^\\?(?:[\w\\]+\\)?(\w+)::class$/.exec(parts[0] ?? "")?.[1];
    const method = parts[1]?.replace(/^['"]|['"]$/g, "");
    if (cls && method) return { handler: `${cls}.${method}`, body: null };
  }
  // `'MatchController:show'`
  const s = stringOf(node);
  const pair = s ? /^(?:[\w\\]+\\)?(\w+):(\w+)$/.exec(s) : null;
  if (pair) return { handler: `${pair[1]}.${pair[2]}`, body: null };
  return { handler: null, body: null };
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path.startsWith("/") ? path : `/${path}`;
  const joined = `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return joined.startsWith("/") ? joined.replace(/\/$/, "") || "/" : `/${joined}`;
}
