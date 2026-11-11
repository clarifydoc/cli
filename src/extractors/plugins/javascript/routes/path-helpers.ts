import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { stripQuotes } from "../../../shared/node-helpers.js";

/**
 * A helper handed the router and the path, registering the route itself:
 *
 *     function mountProgress(app, routePath) { app.get(routePath, handler); }
 *     mountProgress(app, "/api/clubs/:id/progress");
 *
 * The helper's route has no path of its own — it is the parameter, which the
 * Express reader records (`PATH_PARAM_ROUTE`: the function and the parameter's
 * position) — and each call handing it a router and a literal path is a
 * `PATH_HELPER_CALL`. This pass serves the helper's route at every path its
 * calls bind; a helper no call binds keeps its row, whose path stays the
 * unknown hole. A helper name two functions declare binds nothing.
 */

export const PATH_PARAM_ROUTE = "express-path-param";
export const PATH_HELPER_CALL = "express-path-helper-call";

export interface PathParamRoute {
  fn: string;
  index: number;
}

export interface PathHelperCall {
  callee: string;
  /** Each argument's string literal, or null for any other expression. */
  args: Array<string | null>;
}

/** Names a call hands a router by: `app`, `router`, `server`, `api`, and what a router factory made in this file. */
const ROUTER_ARG = /^(?:app|router|server|api|routes?|r)$/i;
const ROUTER_MADE = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?(?:express(?:\s*\.\s*Router)?|Router|Hono|Koa|KoaRouter|fastify|polka)\s*\(/g;
/** Calls that take a path but never register a route. */
const NOT_HELPERS = new Set(["fetch", "require", "import", "get", "post", "put", "patch", "delete", "use", "all", "route", "listen", "join", "resolve", "redirect", "render", "sendFile"]);

/** Every call in the file handing on a router and a literal path (`mountProgress(app, "/api/x")`). */
export function collectPathHelperCalls(root: Node, sourceText: string, facts: RouteFact[]): void {
  if (!/['"`]\//.test(sourceText)) return;
  const made = new Set([...sourceText.matchAll(ROUTER_MADE)].map((m) => m[1]!));
  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    const callee = fn?.type === "identifier" ? fn.text : fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : undefined;
    if (!callee || NOT_HELPERS.has(callee)) continue;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    if (!args.some((a) => a.type === "identifier" && (ROUTER_ARG.test(a.text) || made.has(a.text)))) continue;
    const literal = (a: Node): string | null =>
      (a.type === "string" || (a.type === "template_string" && !a.namedChildren.some((c) => c.type === "template_substitution"))) ? stripQuotes(a.text) : null;
    const values = args.map(literal);
    if (!values.some((v) => v !== null && v.startsWith("/"))) continue;
    facts.push({ kind: PATH_HELPER_CALL, line: call.startPosition.row + 1, data: { callee, args: values } satisfies PathHelperCall });
  }
}

/** The function `node` sits in and its parameter names, for a route whose path is one of them. */
export function enclosingFunction(node: Node): { name: string; params: string[] } | null {
  for (let n: Node | null = node.parent; n; n = n.parent) {
    if (!/^(?:function_declaration|function_expression|function|arrow_function|method_definition|generator_function_declaration)$/.test(n.type)) continue;
    const named = n.childForFieldName("name")?.text
      ?? (n.parent?.type === "variable_declarator" ? n.parent.childForFieldName("name")?.text : undefined)
      ?? (n.parent?.type === "pair" ? n.parent.childForFieldName("key")?.text : undefined);
    if (!named) return null;
    const params = (n.childForFieldName("parameters")?.namedChildren ?? (n.childForFieldName("parameter") ? [n.childForFieldName("parameter")!] : []))
      .map((p) => {
        const id = p.type === "identifier" ? p : p.childForFieldName("pattern") ?? p.childForFieldName("left") ?? p.namedChildren.find((c) => c.type === "identifier");
        return id?.type === "identifier" ? id.text : "";
      });
    return { name: named, params };
  }
  return null;
}

/** Serves each helper's route at the paths its calls hand it. */
export const pathHelperResolver: RouteResolver = {
  id: "express-path-helper",
  languages: ["typescript", "javascript"],
  priority: 35,
  resolve(analyses: FileAnalysis[]): void {
    const helpers = new Map<string, Array<{ a: FileAnalysis; line: number; index: number }>>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== PATH_PARAM_ROUTE) continue;
        const { fn, index } = f.data as PathParamRoute;
        (helpers.get(fn) ?? helpers.set(fn, []).get(fn)!).push({ a, line: f.line, index });
      }
    }
    if (helpers.size === 0) return;
    // A name one file declares: the helper. Two files declaring it: neither.
    const owner = new Map<string, FileAnalysis | null>();
    for (const [fn, list] of helpers) {
      const files = new Set(list.map((h) => h.a));
      owner.set(fn, files.size === 1 ? list[0]!.a : null);
    }
    const bound = new Map<string, Set<string>>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== PATH_HELPER_CALL) continue;
        const call = f.data as PathHelperCall;
        if (!owner.get(call.callee)) continue;
        for (const h of helpers.get(call.callee)!) {
          const path = call.args[h.index];
          if (!path || !path.startsWith("/")) continue;
          (bound.get(`${h.a.filePath}\u0000${h.line}`) ?? bound.set(`${h.a.filePath}\u0000${h.line}`, new Set()).get(`${h.a.filePath}\u0000${h.line}`)!).add(path);
        }
      }
    }
    for (const [key, paths] of bound) {
      const [file, lineText] = key.split("\u0000") as [string, string];
      const a = analyses.find((x) => x.filePath === file)!;
      const line = Number(lineText);
      const placeholders = a.routes.filter((r) => r.line === line && (r.pathUnresolved?.length || r.pathTemplate));
      if (placeholders.length === 0) continue;
      const copies: RouteInfo[] = [];
      for (const r of placeholders) {
        for (const path of [...paths].sort()) {
          const { pathTemplate: _t, pathUnresolved: _u, prefixUnresolved: _p, ...rest } = r;
          copies.push({ ...rest, path, resolvedBy: pathHelperResolver.id });
        }
      }
      a.routes = [...a.routes.filter((r) => !placeholders.includes(r)), ...copies];
    }
  },
};
