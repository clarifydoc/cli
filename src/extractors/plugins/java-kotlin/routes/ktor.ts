import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { ROUTER_CALL, resolveRouterFunctions, type RouterCall } from "../../shared/router-functions.js";
import { findChildByType } from "../../../shared/node-helpers.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { applyRouteMeta, type GuardAttr } from "../../../shared/route-metadata.js";
import type { RouteParamInfo } from "../../../../types/analysis.js";

/**
 * Ktor routing DSL (Kotlin server):
 *
 *   routing {
 *     get("/health") { call.respondText("OK") }
 *     route("/api") {
 *       get("/users") { call.respond(userService.listUsers()) }
 *       post("/users") { ... }
 *     }
 *   }
 *
 * Grammar shape: `get("/x") { ... }` parses as a NESTED call_expression —
 * the inner `get("/x")` (simple_identifier callee + value_arguments) wrapped
 * by an outer call_expression that carries the trailing lambda. The inner
 * node is the match anchor; the outer one supplies the handler body's calls.
 *
 * Routes are often split into extension functions installed by name:
 *
 *   fun Route.userRoutes() { route("/users") { get { … } } }
 *   routing { route("/api") { userRoutes() } }                → GET /api/users
 *
 * A route inside `fun Route.x()` is owned by `x` (`owner: "fn:x"`) with the
 * path the function knows; a call `x()` in a routing block is a
 * `router-call` fact with the block's prefix and guards, and
 * `ktorRouteFnResolver` (the shared router-functions kit) composes them.
 *
 * The verb names are maximally generic (`get`), so a route is only emitted
 * when the call sits under a `routing { }` / `route("…") { }` ancestor (or in a
 * `Route` extension function) —
 * a stray `get("key")` helper elsewhere in a Ktor file never qualifies. The
 * extractor itself is additionally gated on the file importing io.ktor.
 */

const KTOR_VERBS: ReadonlySet<string> = new Set([
  "get", "post", "put", "delete", "patch", "head", "options",
]);

/** First string-literal argument of a call_expression, unquoted. */
function firstStringArg(call: Node): string | null {
  const suffix = findChildByType(call, "call_suffix");
  const args = suffix ? findChildByType(suffix, "value_arguments") : null;
  if (!args) return null;
  for (const arg of args.children) {
    if (arg.type !== "value_argument") continue;
    const s = findChildByType(arg, "string_literal");
    if (s) return s.text.replace(/^"|"$/g, "");
    return null; // first arg is not a string — not a path
  }
  return null;
}

/** The simple-identifier callee of a call_expression, or null. */
function calleeName(call: Node): string | null {
  const c = call.child(0);
  return c?.type === "simple_identifier" ? c.text : null;
}

/**
 * Climb enclosing DSL blocks: collect `route("prefix")` segments (outermost
 * first) and report whether a routing/route anchor exists at all.
 */
/** `fun Route.userRoutes() { … }` → `userRoutes`: a function that registers on the route it extends. */
function routeExtensionName(fn: Node): string | null {
  const recv = fn.namedChildren.find((c) => c.type === "user_type");
  if (!recv || !/^(?:Route|Routing)$/.test(recv.text)) return null;
  return fn.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
}

interface DslContext {
  prefixes: string[];
  anchored: boolean;
  guards: GuardAttr[];
  /** The `Route` extension function the node is in, when no `routing { }` is nearer. */
  ownerFn: string | null;
  /** The node sits in a verb's handler lambda. */
  inVerb: boolean;
}

function dslContext(node: Node): DslContext {
  const prefixes: string[] = [];
  const guards: GuardAttr[] = [];
  let anchored = false;
  let ownerFn: string | null = null;
  let inVerb = false;
  // Only `routing { }` makes the path absolute; `route("/x") { }` inside an extension stays relative to its caller.
  let sawRouting = false;
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === "function_declaration") {
      // Lexical scope ends at the function: what is outside is wherever it is called.
      const ext = routeExtensionName(cur);
      if (ext && !sawRouting) {
        anchored = true;
        ownerFn = ext;
      }
      break;
    }
    if (cur.type === "call_expression") {
      const inner = cur.child(0);
      if ((inner?.type === "call_expression" && KTOR_VERBS.has(calleeName(inner) ?? "")) || KTOR_VERBS.has(calleeName(cur) ?? "")) inVerb = true;
      if (inner?.type === "call_expression" && calleeName(inner) === "route") {
        const p = firstStringArg(inner);
        if (p) prefixes.unshift(p);
        anchored = true;
      } else if (inner?.type === "call_expression" && calleeName(inner) === "authenticate") {
        // `authenticate("jwt") { get(...) }` — Ktor's auth plugin guards the
        // block with the named configuration (the scheme).
        const scheme = firstStringArg(inner);
        guards.unshift({ text: scheme ? `authenticate("${scheme}")` : "authenticate", schemes: scheme ? [scheme] : [] });
      } else if (calleeName(cur) === "routing" || calleeName(cur) === "route") {
        anchored = true;
        if (calleeName(cur) === "routing") sawRouting = true;
      } else if (calleeName(cur) === "authenticate") {
        guards.unshift({ text: "authenticate", schemes: [] });
      }
    }
    cur = cur.parent;
  }
  return { prefixes, anchored, guards, ownerFn, inVerb };
}

/** DSL calls that are not installing a route function. */
const DSL_CALLS = new Set([...KTOR_VERBS, "route", "routing", "authenticate", "install", "static", "staticResources", "staticFiles", "intercept", "handle", "method", "accept", "contentType", "header", "param", "optionalParam", "host", "port", "webSocket", "sse", "rateLimit", "println"]);

/**
 * What the handler lambda reads from the request — Ktor has no parameter
 * list, so the bindings are the `call.*` accesses in the body:
 *   call.parameters["id"]                → route
 *   call.request.queryParameters["q"]    → query
 *   call.request.headers["X-T"]          → header
 *   call.receive<CreateUser>()           → body, typed
 *   call.receiveParameters()             → form
 */
function lambdaParams(lambda: Node | null, path: string): RouteParamInfo[] {
  if (!lambda) return [];
  const text = lambda.text;
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const push = (p: RouteParamInfo): void => {
    const key = `${p.binding}:${p.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  };
  for (const m of text.matchAll(/call\.parameters\[\s*"([^"]+)"\s*\]/g)) push({ name: m[1]!, type: null, binding: "route" });
  for (const m of text.matchAll(/call\.parameters\.getOrFail(?:<([\w.<>?]+)>)?\(\s*"([^"]+)"/g)) push({ name: m[2]!, type: m[1] ?? null, binding: "route" });
  for (const m of text.matchAll(/queryParameters\[\s*"([^"]+)"\s*\]/g)) push({ name: m[1]!, type: null, binding: "query" });
  for (const m of text.matchAll(/queryParameters\.getOrFail(?:<([\w.<>?]+)>)?\(\s*"([^"]+)"/g)) push({ name: m[2]!, type: m[1] ?? null, binding: "query" });
  for (const m of text.matchAll(/request\.headers?\[\s*"([^"]+)"\s*\]/g)) push({ name: m[1]!, type: null, binding: "header" });
  for (const m of text.matchAll(/call\.receive<([\w.<>?]+)>\(\)/g)) push({ name: "body", type: m[1]!, binding: "body" });
  for (const m of text.matchAll(/call\.receive\(\s*([\w.]+)::class\s*\)/g)) push({ name: "body", type: m[1]!, binding: "body" });
  if (/call\.receiveParameters\(\)|call\.receiveMultipart\(\)/.test(text)) push({ name: "form", type: null, binding: "form" });
  void path;
  return out;
}

function joinPath(prefixes: string[], path: string | null): string {
  const parts = [...prefixes, path ?? ""]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return "/" + parts.join("/");
}

export function extractKtorRoutes(root: Node, routes: RouteInfo[], facts?: RouteFact[]): void {
  const visit = (node: Node): void => {
    if (node.type === "call_expression") {
      const verb = calleeName(node);
      // `userRoutes()` in a routing block: a Route extension installed here.
      if (facts && verb && !DSL_CALLS.has(verb) && node.child(1)?.type === "call_suffix") {
        const ctx = dslContext(node);
        if (ctx.anchored && !ctx.inVerb) {
          const call: RouterCall = { callee: verb, prefix: joinPath(ctx.prefixes, null), relative: ctx.ownerFn !== null, guards: ctx.guards };
          facts.push({ kind: ROUTER_CALL, line: node.startPosition.row + 1, ...(ctx.ownerFn ? { owner: ctx.ownerFn } : {}), data: call });
        }
      }
      if (verb && KTOR_VERBS.has(verb)) {
        // Path-arg form: this is the inner call; the outer wrapper (if any)
        // carries the trailing lambda. Path-less form (`get { }`) has the
        // lambda directly on this node and inherits the enclosing prefix.
        const path = firstStringArg(node);
        const { prefixes, anchored, guards, ownerFn } = dslContext(node);
        if (anchored) {
          // NOTE: compare node identity via .id — web-tree-sitter mints a new
          // wrapper object on every child() access, so === is always false.
          const outer =
            node.parent?.type === "call_expression" && node.parent.child(0)?.id === node.id
              ? node.parent
              : node;
          const lambda = findChildByType(outer, "call_suffix")
            ? findChildByType(findChildByType(outer, "call_suffix")!, "annotated_lambda")
            : null;
          const fullPath = joinPath(prefixes, path);
          const route: RouteInfo = {
            path: fullPath,
            httpMethod: verb.toUpperCase(),
            kind: "api",
            handler: null,
            calls: lambda ? extractCalls(lambda, "kotlin") : [],
            middleware: [],
            line: node.startPosition.row + 1,
            ...(ownerFn ? { owner: `fn:${ownerFn}` } : {}),
          };
          applyRouteMeta(route, { inheritedGuards: guards, params: lambdaParams(lambda, fullPath) });
          routes.push(route);
        }
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
}

/**
 * Ktor route functions, installed by name: the one function of that name
 * among the project's `Route` extensions, the caller's own file first.
 */
export const ktorRouteFnResolver: RouteResolver = {
  id: "ktor-route-functions",
  languages: ["kotlin"],
  priority: 45,
  resolve(analyses: FileAnalysis[]): void {
    resolveRouterFunctions(analyses, {
      unitOf: (f) => f,
      target(callee, caller, keysNamed) {
        const keys = keysNamed(callee);
        const own = `${caller.filePath}#${callee}`;
        return keys.includes(own) ? own : keys.length === 1 ? keys[0]! : null;
      },
    });
  },
};
