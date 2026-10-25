import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { collectCallNames, HTTP_METHODS } from "../../../routes/base.js";
import { isRoutePath } from "./express.js";

/**
 * A raw Node server dispatching by hand: inside the request listener of `http.createServer(…)`
 * (or `https.` / a bare `createServer`), an `if` whose condition compares the request path with a
 * literal — `pathname === "/clubs"`, `req.url == "/health"` — serves that path, at the method a
 * `req.method === "POST"` in the same condition names (any method otherwise); a `switch (pathname)`
 * serves each literal `case`. The path is `req.url`, or a value whose name says it is one
 * (`pathname`, `path`, `url`, `route`). The branch's calls are the route's.
 */

export function mayDispatchByHand(sourceText: string): boolean {
  return sourceText.includes("createServer(");
}

const FUNCTION_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "function", "function_declaration"]);
const PATH_NAME = /^(?:pathname|path|url|route|urlPath|reqPath|requestPath)$/;

/** The request listener `createServer` is handed: inline, or a function this file declares. */
function listenerOf(call: Node, root: Node): Node | null {
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  // `createServer(options, listener)`: the listener comes last.
  const fn = args.find((a) => FUNCTION_TYPES.has(a.type)) ?? [...args].reverse().find((a) => a.type === "identifier");
  if (!fn) return null;
  if (FUNCTION_TYPES.has(fn.type)) return fn;
  for (const stmt of root.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.namedChildren[0] : stmt;
    if (decl?.type === "function_declaration" && decl.childForFieldName("name")?.text === fn.text) return decl;
    if (decl?.type === "lexical_declaration" || decl?.type === "variable_declaration") {
      for (const d of decl.namedChildren) {
        const value = d.childForFieldName("value");
        if (d.childForFieldName("name")?.text === fn.text && value && FUNCTION_TYPES.has(value.type)) return value;
      }
    }
  }
  return null;
}

function firstParamName(fn: Node): string | null {
  const params = fn.childForFieldName("parameters");
  const first = params ? params.namedChildren[0] : fn.childForFieldName("parameter");
  const ident = first?.type === "identifier" ? first : first?.childForFieldName("pattern");
  return ident?.type === "identifier" ? ident.text : null;
}

/** Is `node` the request's path: `req.url`, or a value named like one? */
function isPathExpr(node: Node, req: string): boolean {
  if (node.type === "identifier") return PATH_NAME.test(node.text);
  if (node.type === "member_expression") {
    const object = node.childForFieldName("object")?.text;
    const prop = node.childForFieldName("property")?.text ?? "";
    return (object === req && prop === "url") || prop === "pathname";
  }
  return false;
}

function isMethodExpr(node: Node, req: string): boolean {
  return node.type === "member_expression" && node.childForFieldName("object")?.text === req && node.childForFieldName("property")?.text === "method";
}

/** The `a === b` comparisons a condition joins with `&&` (an `||` keeps each side). */
function comparisons(cond: Node, out: Array<[Node, Node]>): void {
  let n = cond;
  while (n.type === "parenthesized_expression" && n.namedChildren[0]) n = n.namedChildren[0];
  if (n.type !== "binary_expression") return;
  const op = n.childForFieldName("operator")?.text;
  const left = n.childForFieldName("left");
  const right = n.childForFieldName("right");
  if (!left || !right) return;
  if (op === "&&") {
    comparisons(left, out);
    comparisons(right, out);
  } else if (op === "===" || op === "==") {
    out.push([left, right]);
  }
}

/** The literal compared with an expression `test` accepts, either way round. */
function comparedLiteral(pairs: Array<[Node, Node]>, test: (n: Node) => boolean): string | null {
  for (const [a, b] of pairs) {
    if (test(a) && b.type === "string") return stripQuotes(b.text);
    if (test(b) && a.type === "string") return stripQuotes(a.text);
  }
  return null;
}

function route(path: string, method: string | null, body: Node | null, line: number): RouteInfo {
  return { path, httpMethod: method ?? "ALL", kind: "api", handler: null, calls: body ? collectCallNames(body) : [], middleware: [], line };
}

export function extractNodeHttpRoutes(root: Node, routes: RouteInfo[]): void {
  const listeners: Node[] = [];
  const find = (node: Node): void => {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const name = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : callee?.text;
      if (name === "createServer") {
        const fn = listenerOf(node, root);
        if (fn && !listeners.includes(fn)) listeners.push(fn);
      }
    }
    for (const child of node.namedChildren) find(child);
  };
  find(root);

  for (const fn of listeners) {
    const req = firstParamName(fn);
    if (!req) continue;
    const seen = new Set<string>();
    const add = (r: RouteInfo) => {
      const key = `${r.httpMethod} ${r.path}`;
      if (seen.has(key)) return;
      seen.add(key);
      routes.push(r);
    };
    const walk = (node: Node): void => {
      // A function nested in the listener is its own scope (a helper, a callback); its branches are not dispatch.
      if (node !== fn && FUNCTION_TYPES.has(node.type)) return;
      if (node.type === "if_statement") {
        const pairs: Array<[Node, Node]> = [];
        const cond = node.childForFieldName("condition");
        if (cond) comparisons(cond, pairs);
        const path = comparedLiteral(pairs, (n) => isPathExpr(n, req));
        const verb = comparedLiteral(pairs, (n) => isMethodExpr(n, req));
        if (path !== null && isRoutePath(path) && (verb === null || HTTP_METHODS.has(verb.toLowerCase()))) {
          add(route(path, verb?.toUpperCase() ?? null, node.childForFieldName("consequence"), node.startPosition.row + 1));
        }
      } else if (node.type === "switch_statement") {
        let value = node.childForFieldName("value");
        while (value?.type === "parenthesized_expression" && value.namedChildren[0]) value = value.namedChildren[0];
        if (value && isPathExpr(value, req)) {
          for (const c of node.childForFieldName("body")?.namedChildren ?? []) {
            const v = c.type === "switch_case" ? c.childForFieldName("value") : null;
            if (v?.type === "string" && isRoutePath(stripQuotes(v.text))) add(route(stripQuotes(v.text), null, c, c.startPosition.row + 1));
          }
        }
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(fn);
  }
}
