import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { findChildByType } from "../../../shared/node-helpers.js";
import { extractCalls } from "../../../shared/call-graph.js";

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
 * The verb names are maximally generic (`get`), so a route is only emitted
 * when the call sits under a `routing { }` / `route("…") { }` ancestor —
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
function dslContext(node: Node): { prefixes: string[]; anchored: boolean } {
  const prefixes: string[] = [];
  let anchored = false;
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === "call_expression") {
      const inner = cur.child(0);
      if (inner?.type === "call_expression" && calleeName(inner) === "route") {
        const p = firstStringArg(inner);
        if (p) prefixes.unshift(p);
        anchored = true;
      } else if (calleeName(cur) === "routing" || calleeName(cur) === "route") {
        anchored = true;
      }
    }
    cur = cur.parent;
  }
  return { prefixes, anchored };
}

function joinPath(prefixes: string[], path: string | null): string {
  const parts = [...prefixes, path ?? ""]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return "/" + parts.join("/");
}

export function extractKtorRoutes(root: Node, routes: RouteInfo[]): void {
  const visit = (node: Node): void => {
    if (node.type === "call_expression") {
      const verb = calleeName(node);
      if (verb && KTOR_VERBS.has(verb)) {
        // Path-arg form: this is the inner call; the outer wrapper (if any)
        // carries the trailing lambda. Path-less form (`get { }`) has the
        // lambda directly on this node and inherits the enclosing prefix.
        const path = firstStringArg(node);
        const { prefixes, anchored } = dslContext(node);
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
          routes.push({
            path: joinPath(prefixes, path),
            httpMethod: verb.toUpperCase(),
            kind: "api",
            handler: null,
            calls: lambda ? extractCalls(lambda, "kotlin") : [],
            middleware: [],
            line: node.startPosition.row + 1,
          });
        }
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
}
