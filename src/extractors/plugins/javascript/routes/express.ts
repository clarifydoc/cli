import type { Node } from "web-tree-sitter";
import type { RouteInfo, CallInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { HTTP_METHODS, collectCallNames } from "../../../routes/base.js";

/**
 * Receivers whose `.get()/.post()/...` are NOT route definitions: HTTP clients
 * (jQuery/axios/fetch — these are *outbound* requests) and common getter
 * objects (`res.get('etag')`, `options.get('minSpotColor')`, `map.get(k)`).
 * Compared lowercased against the immediate object of the member expression.
 * Overlaps with the JS plugin's `apiCallRoots` by design — both describe
 * "this isn't an Express router" — but kept local to avoid a meta→plugin cycle.
 */
const NON_ROUTER_RECEIVERS: ReadonlySet<string> = new Set([
  // jQuery / HTTP clients (outbound calls)
  "$", "jquery", "jq", "$http", "$ajax", "ajax",
  "axios", "fetch", "ky", "got", "superagent", "request", "http", "https",
  "xhr", "client", "apiclient", "httpclient", "fetchclient",
  // Browser globals & common config/collection/getter objects
  "window", "document", "navigator", "localstorage", "sessionstorage",
  "options", "opts", "config", "settings", "params", "searchparams",
  "headers", "cache", "store", "map", "req", "res", "response", "ctx",
]);

/**
 * A real Express/router path starts with "/" (`/users/:id`) or is the "*"
 * catch-all. Config keys (`'minSpotColor'`) and CSS selectors (`'button'`)
 * don't — this rejects `.get()`-shaped calls that aren't routes.
 */
export function isRoutePath(path: string): boolean {
  return path === "*" || path.startsWith("/");
}

/** The immediate object a member expression is called on, lowercased (e.g. `$.get` → "$"). */
function receiverName(memberExpr: Node): string | null {
  const object = memberExpr.childForFieldName("object");
  if (!object) return null;
  if (object.type === "identifier") return object.text.toLowerCase();
  // `req.app.get(...)` → use the nearest segment ("app"), which is a router.
  if (object.type === "member_expression") {
    return object.childForFieldName("property")?.text?.toLowerCase() ?? null;
  }
  return null;
}

/** Express-style: app.get("/path", handler) */
export function extractExpressRoutes(root: Node, routes: RouteInfo[]): void {
  walkForRoutes(root, routes);
}

function walkForRoutes(node: Node, routes: RouteInfo[]) {
  visitExpressRoute(node, routes);
  for (const child of node.children) {
    walkForRoutes(child, routes);
  }
}

/** Inspect a single node for an Express-style route registration. */
export function visitExpressRoute(node: Node, routes: RouteInfo[]): void {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "member_expression") {
      const prop = fn.childForFieldName("property");
      const method = prop?.text?.toLowerCase();
      const receiver = receiverName(fn);

      // Outbound HTTP clients are excluded both by the denylist and by a
      // `*Client` suffix (`accountApiClient`, `licenseApiClient`, …) that no
      // fixed list could enumerate — these carry a body/config arg, not a handler.
      const isClientReceiver = !!receiver && (NON_ROUTER_RECEIVERS.has(receiver) || /client$/.test(receiver));
      if (method && HTTP_METHODS.has(method) && !isClientReceiver) {
        const args = node.childForFieldName("arguments");
        if (args) {
          const firstArg = args.child(1); // skip '('
          if (
            firstArg &&
            (firstArg.type === "string" || firstArg.type === "template_string") &&
            isRoutePath(stripQuotes(firstArg.text))
          ) {
            const path = stripQuotes(firstArg.text);
            let handler: string | null = null;
            const middleware: string[] = [];
            const kids = args.children;
            for (let i = 2; i < kids.length - 1; i++) {
              const arg = kids[i]!;
              if (arg.type === "," || arg.type === "(") continue;
              if (arg.type === "identifier" || arg.type === "member_expression") {
                if (handler) middleware.push(handler);
                handler = arg.text;
              }
            }

            let calls: CallInfo[] = [];
            const lastArg = args.child(args.childCount - 2);
            const lastArgIsFn =
              !!lastArg &&
              (lastArg.type === "arrow_function" ||
                lastArg.type === "function_expression" ||
                lastArg.type === "function");
            if (lastArgIsFn) {
              calls = collectCallNames(lastArg!);
            }

            // A real Express/router registration always supplies a handler — a
            // function (`app.get("/x", (req,res)=>…)`) or a middleware/handler
            // identifier (`app.get("/x", getUsers)`). An outbound HTTP-client
            // call (`apiClient.get("/x", { params })`) has only a URL + optional
            // config object and NO handler, so the receiver denylist can't keep
            // up with names like `accountApiClient`. Require a handler so those
            // stay api-calls instead of inflating the route map (and colliding
            // with the real backend route in the frontend→API join).
            if (handler !== null || lastArgIsFn) {
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
  }
}
