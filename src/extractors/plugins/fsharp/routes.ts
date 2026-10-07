import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo } from "../../../types/analysis.js";
import type { RouteExtractor } from "../../routes/base.js";
import { calleeName, flattenApplication, stringValue } from "./syntax.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** Giraffe path matchers: a literal path, or a `%i`-format one whose values feed the handler. */
const ROUTE_FNS = new Set(["route", "routeCi", "routex", "routeCix", "routeStartsWith", "routeStartsWithCi", "routef", "routeCif", "routexp"]);
const SUBROUTE_FNS = new Set(["subRoute", "subRouteCi", "subRoutef"]);
/** Saturn `router { get "/x" h }` / Falco `[ get "/x" h ]` verbs (`getf` takes a format path). */
const VERB_FNS = /^(get|post|put|patch|delete|head|options)f?$/;
const MINIMAL_API = /\.Map(Get|Post|Put|Patch|Delete)$/;

/** Giraffe's `%i` / `%s` / `%O` placeholders → `{int}` / `{string}` / `{guid}`. */
function formatPath(path: string): string {
  const kinds: Record<string, string> = { i: "int", d: "int", s: "string", O: "guid", f: "float", b: "bool", c: "char", u: "uint" };
  return path.replace(/%([idsObfcu])/g, (_m, k: string) => `{${kinds[k]}}`);
}

function join(prefix: string, path: string): string {
  const joined = (prefix.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "")).replace(/\/+$/, "");
  return joined === "" ? "/" : joined;
}

interface Ctx { method: string | null; prefix: string }
type Token = Node | ">=>";

const isComposition = (n: Node) => n.type === "infix_expression" && n.namedChildren.some((c) => c.type === "infix_op" && c.text === ">=>");

/**
 * An expression as the sequence a reader sees: `GET >=> route "/x" >=> h`
 * → [GET, >=>, route, "/x", >=>, h]. The grammar nests applications and
 * `>=>` the other way round (`route` and its path land in different nodes),
 * so the route reading works on this flat form: split at `>=>`, each segment
 * is one application — its head and arguments.
 */
function linearize(node: Node, out: Token[] = []): Token[] {
  if (node.type === "application_expression") {
    for (const c of node.namedChildren) linearize(c, out);
  } else if (isComposition(node)) {
    for (const c of node.namedChildren) {
      if (c.type === "infix_op") out.push(">=>");
      else linearize(c, out);
    }
  } else out.push(node);
  return out;
}

/**
 * F# web routes:
 *  - Giraffe: `GET >=> route "/x" >=> handler`, `routef "/x/%i" handler`,
 *    `choose [ … ]`, `subRoute "/api" (choose [ … ])` — a method combinator
 *    applies to everything after it in its `>=>` chain;
 *  - Saturn (`router { get "/x" handler }`) and Falco (`[ get "/x" handler ]`),
 *    read only when the file opens Saturn or Falco;
 *  - ASP.NET Core minimal APIs: `app.MapGet("/x", Func<…>(handler))`.
 * The handler is the function the route ends in, when it is named.
 */
export const fsharpRouteExtractor: RouteExtractor = {
  languages: ["fsharp"],
  extractRoutes(tree: Tree, sourceText: string): RouteInfo[] {
    if (!/\b(?:route|routef|subRoute|Map(?:Get|Post|Put|Patch|Delete)|router|Falco)\b/.test(sourceText)) return [];
    const verbsAllowed = /^\s*open\s+(?:Saturn|Falco)\b/m.test(sourceText);
    const routes: RouteInfo[] = [];
    const emit = (at: Node, ctx: Ctx, path: string, handler: Node | null) =>
      routes.push({
        path: join(ctx.prefix, formatPath(path)),
        httpMethod: ctx.method,
        kind: "api",
        handler: handler ? handlerName(handler) : null,
        calls: [],
        middleware: [],
        line: at.startPosition.row + 1,
      });

    const expression = (node: Node, outer: Ctx): void => {
      if (node.type !== "application_expression" && !isComposition(node)) {
        for (const c of node.namedChildren) expression(c, outer);
        return;
      }
      const tokens = linearize(node);
      const segments: Node[][] = [[]];
      for (const t of tokens) {
        if (t === ">=>") segments.push([]);
        else segments[segments.length - 1]!.push(t);
      }
      const ctx = { ...outer };
      let pending: { at: Node; path: string } | null = null;
      for (const seg of segments) {
        const [head, ...args] = seg;
        if (!head) continue;
        const name = head.type === "long_identifier_or_op" || head.type === "typed_expression" || head.type === "dot_expression" ? calleeName(head) : null;
        if (name && METHODS.has(name)) {
          // `GET >=> …` sets the method for the rest of the chain; endpoint
          // routing's `GET [ route "/x" h ]` sets it for the routes it lists.
          if (args.length === 0) ctx.method = name;
          else for (const a of args) expression(a, { ...ctx, method: name });
          continue;
        }
        if (pending) { emit(pending.at, ctx, pending.path, head); pending = null; continue; }
        const path = args[0] ? stringValue(args[0]) : null;
        if (name && ROUTE_FNS.has(name) && path !== null) {
          if (args[1]) emit(head, ctx, path, args[1]);
          else pending = { at: head, path };
          continue;
        }
        if (name && SUBROUTE_FNS.has(name) && path !== null) {
          for (const a of args.slice(1)) expression(a, { ...ctx, prefix: join(ctx.prefix, path) });
          continue;
        }
        const verb = name && verbsAllowed ? VERB_FNS.exec(name) : null;
        if (verb && path !== null) { emit(head, { ...ctx, method: verb[1]!.toUpperCase() }, path, args[1] ?? null); continue; }
        const minimal = name ? MINIMAL_API.exec(name) : null;
        if (minimal) {
          const tuple = args[0]?.type === "paren_expression" ? args[0].namedChildren[0] : args[0];
          const parts = tuple?.type === "tuple_expression" ? tuple.namedChildren : tuple ? [tuple] : [];
          const mpath = parts[0] ? stringValue(parts[0]) : null;
          if (mpath !== null) { emit(head, { ...ctx, method: minimal[1]!.toUpperCase() }, mpath, parts[1] ?? null); continue; }
        }
        // Any other application — `choose [ … ]`, a lambda, a helper — may hold routes in its operands.
        for (const n of seg) if (n !== head || !name) expression(n, ctx);
      }
      if (pending) emit(pending.at, ctx, pending.path, null);
    };

    expression(tree.rootNode, { method: null, prefix: "" });
    return routes;
  },
};

/** `getOrder`, `Handlers.create`, `Func<…>(handler)`, `(fun next ctx -> …)` → a name, or null for a lambda. */
function handlerName(node: Node): string | null {
  if (node.type === "long_identifier_or_op") return calleeName(node);
  if (node.type === "paren_expression") return node.namedChildren[0] ? handlerName(node.namedChildren[0]) : null;
  if (node.type === "application_expression") {
    const { head, args } = flattenApplication(node);
    const name = calleeName(head);
    // `Func<HttpContext, Task>(handler)` wraps the handler it names.
    if (name && /^(?:Func|Action)$/.test(name) && args[0]) return handlerName(args[0]);
    return name;
  }
  if (node.type === "typed_expression") return calleeName(node.namedChildren[0]!);
  return null;
}
