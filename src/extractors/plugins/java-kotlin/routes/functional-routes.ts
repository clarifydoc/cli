import type { Node } from "web-tree-sitter";
import type { CallInfo, RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { extractCalls } from "../../../shared/call-graph.js";

/**
 * Functional routing that names its handlers by method reference:
 *
 *   RouterFunctions.route(GET("/clubs"), handler::all).andRoute(POST("/clubs/{id}"), handler::one)   // Java, static
 *   coRouter { "/api/cars".nest { GET("", handler::list) } }                                       // Kotlin DSL
 *
 * and the typed handler of `route().GET("/x", handler::all)`: a reference through a parameter, field or
 * local whose declared type is a class names `Type#method`, so the linker joins the one class's method
 * instead of guessing among namesakes. `this::x` and an untyped receiver stay the bare method name.
 */

export const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** The class a type node names: generics, nullability and package qualifiers dropped. Null for `var`/primitives. */
function typeName(text: string): string | null {
  const bare = text.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, "").replace(/[?\s]/g, "").split(".").pop() ?? "";
  return /^[A-Z]\w*$/.test(bare) ? bare : null;
}

const SCOPES = new Set(["method_declaration", "constructor_declaration", "function_declaration", "lambda_literal", "lambda_expression"]);
const MEMBER_HOLDERS = new Set(["class_body", "primary_constructor"]);

/** `(name, type)` a declaration node states, or null: Java params, fields and locals; Kotlin params, properties and class parameters. */
function declaredBy(d: Node): Array<[string, string | null]> {
  switch (d.type) {
    case "formal_parameter":
    case "spread_parameter": {
      const name = d.childForFieldName("name")?.text;
      const type = d.childForFieldName("type")?.text;
      return name ? [[name, type ? typeName(type) : null]] : [];
    }
    case "local_variable_declaration":
    case "field_declaration": {
      const type = d.childForFieldName("type")?.text;
      const out: Array<[string, string | null]> = [];
      for (const v of d.namedChildren) {
        if (v.type !== "variable_declarator") continue;
        const name = v.childForFieldName("name")?.text;
        if (!name) continue;
        const init = v.childForFieldName("value");
        const made = init?.type === "object_creation_expression" ? init.childForFieldName("type")?.text : null;
        out.push([name, (type && type !== "var" ? typeName(type) : null) ?? (made ? typeName(made) : null)]);
      }
      return out;
    }
    case "parameter":
    case "class_parameter":
    case "variable_declaration": {
      const name = d.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      const type = d.namedChildren.find((c) => c.type === "user_type" || c.type === "nullable_type")?.text;
      return name ? [[name, type ? typeName(type) : null]] : [];
    }
    case "property_declaration": {
      const v = d.namedChildren.find((c) => c.type === "variable_declaration");
      const out = v ? declaredBy(v) : [];
      if (out[0] && !out[0][1]) {
        const init = d.namedChildren.find((c) => c.type === "call_expression");
        const callee = init?.firstChild?.type === "simple_identifier" ? init.firstChild.text : null;
        if (callee) out[0][1] = typeName(callee);
      }
      return out;
    }
    default:
      return [];
  }
}

const LOCAL_DECLS = new Set(["formal_parameter", "spread_parameter", "local_variable_declaration", "parameter", "property_declaration"]);
const MEMBER_DECLS = new Set(["field_declaration", "property_declaration", "class_parameter"]);

/** The declared class of a variable in scope at `from`: the enclosing methods' parameters and locals, then the class's fields. */
function declaredType(from: Node, name: string): string | null {
  for (let cur: Node | null = from.parent; cur; cur = cur.parent) {
    if (SCOPES.has(cur.type)) {
      const found = cur.descendantsOfType([...LOCAL_DECLS]).flatMap((d) => (d ? declaredBy(d) : [])).find(([n]) => n === name);
      if (found) return found[1];
    } else if (MEMBER_HOLDERS.has(cur.type) || cur.type === "class_declaration") {
      const holders = cur.type === "class_declaration" ? cur.namedChildren.filter((c) => MEMBER_HOLDERS.has(c.type)) : [cur];
      for (const h of holders) {
        for (const m of h.namedChildren) {
          if (!MEMBER_DECLS.has(m.type)) continue;
          const found = declaredBy(m).find(([n]) => n === name);
          if (found) return found[1];
        }
      }
    }
  }
  return null;
}

/** A method reference's handler: `Type#method` through a typed receiver (or a class name), else the bare method. */
export function methodRefHandler(ref: Node): string | null {
  const [receiver, method] = ref.text.split("::").map((s) => s.trim());
  if (!method || !/^\w+$/.test(method)) return null;
  if (!receiver || receiver === "this" || receiver === "super") return method;
  if (/^[A-Z]\w*$/.test(receiver)) return `${receiver}#${method}`;
  if (!/^\w+$/.test(receiver)) return method;
  const type = declaredType(ref, receiver);
  return type ? `${type}#${method}` : method;
}

/** The first `GET("/x")`-style predicate in a route's first argument, `GET("/x").and(accept(JSON))` included. */
function predicateVerb(node: Node): { verb: string; path: Node | undefined } | null {
  if (node.type === "method_invocation") {
    const verb = node.childForFieldName("name")?.text ?? "";
    const obj = node.childForFieldName("object")?.text;
    if (VERBS.has(verb) && (!obj || /(?:^|\.)RequestPredicates$/.test(obj))) {
      return { verb, path: node.childForFieldName("arguments")?.namedChildren[0] };
    }
  }
  for (const c of node.namedChildren) {
    const found = predicateVerb(c);
    if (found) return found;
  }
  return null;
}

const pathOf = (n: Node | undefined): string | null => {
  const lit = n ? literalIn(n) : null;
  return lit === null ? null : lit;
};

function literalIn(node: Node): string | null {
  if (node.type === "string_literal" || node.type === "string") return stripQuotes(node.text);
  for (const c of node.namedChildren) {
    const found = literalIn(c);
    if (found !== null) return found;
  }
  return null;
}

const join = (prefix: string, path: string): string => {
  const p = path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
  return prefix + p || "/";
};

/**
 * Java: `RouterFunctions.route(GET("/x"), handler::all)` and its `.andRoute(POST("/x"), handler::one)`.
 * Null when the call is no predicate route. The nest prefix is the caller's to add.
 */
export function staticRoute(node: Node): { verb: string; path: string; handler: string | null; calls: CallInfo[]; line: number } | null {
  const name = node.childForFieldName("name")?.text;
  if (name !== "route" && name !== "andRoute") return null;
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  if (args.length < 2) return null;
  const pred = predicateVerb(args[0]!);
  const path = pred ? pathOf(pred.path) : null;
  if (!pred || path === null) return null;
  const h = args[1]!;
  return {
    verb: pred.verb,
    path,
    handler: h.type === "method_reference" ? methodRefHandler(h) : null,
    calls: h.type === "lambda_expression" ? extractCalls(h, "java") : [],
    line: (node.childForFieldName("name") ?? node).startPosition.row + 1,
  };
}

// ─── Kotlin router DSL ──────────────────────────────────────────────────────

const callee = (call: Node): string | null => (call.firstChild?.type === "simple_identifier" ? call.firstChild.text : null);
const lambdaOf = (call: Node): Node | null => call.descendantsOfType("annotated_lambda").find((l) => l?.parent?.parent?.id === call.id || l?.parent?.id === call.id) ?? null;

/** Routes of a `router { … }` / `coRouter { … }` block: verbs with their `"/x".nest { … }` / `nest("/x") { … }` prefixes. */
export function extractKotlinRouterDsl(root: Node, routes: RouteInfo[]): void {
  const visit = (node: Node, prefix: string): void => {
    if (node.type === "call_expression") {
      const name = callee(node);
      if (name && VERBS.has(name)) {
        const args = node.descendantsOfType("value_arguments").find((a) => a?.parent?.parent?.id === node.id)?.namedChildren ?? [];
        const first = args[0]?.namedChildren[0];
        const ref = args.map((a) => a.namedChildren[0]).find((n) => n?.type === "callable_reference");
        const path = first?.type === "callable_reference" ? "" : first ? pathOf(first) : null;
        if (path !== null) {
          const lambda = lambdaOf(node);
          routes.push({
            path: join(prefix, path),
            httpMethod: name,
            kind: "api",
            handler: ref ? methodRefHandler(ref) : null,
            calls: lambda ? extractCalls(lambda, "kotlin") : [],
            middleware: [],
            line: node.startPosition.row + 1,
          });
        }
        return;
      }
      const nestPrefix = nestPrefixOf(node);
      if (nestPrefix !== null) {
        // The grammar reads `GET("/a") { … }` + a newline + `("/x" and accept(JSON)).nest { … }` as one call chain:
        // the statement before the nest is a route of its own, at the prefix it stands in.
        const before = statementBeforeNest(node);
        if (before) visit(before, prefix);
        const body = lambdaOf(node);
        if (body) visit(body, join(prefix, nestPrefix) === "/" ? prefix : join(prefix, nestPrefix));
        return;
      }
    }
    for (const c of node.namedChildren) visit(c, prefix);
  };
  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const name = callee(call);
    if (name !== "router" && name !== "coRouter") continue;
    const body = lambdaOf(call);
    if (body) visit(body, "");
  }
}

/**
 * A nest whose receiver the grammar glued to the statement above it: `GET("/a") { … }` then, on the next line,
 * `("/x" and accept(JSON)).nest { … }` parses as `GET("/a") { … }("/x" and …)`. That statement, or null when the
 * parenthesis starts on the line the call ends on (a real call continuation).
 */
function statementBeforeNest(call: Node): Node | null {
  const receiver = call.firstChild?.type === "navigation_expression" ? call.firstChild.firstChild : null;
  const inner = receiver?.type === "call_expression" ? receiver.firstChild : null;
  const suffix = receiver?.lastChild;
  if (inner?.type !== "call_expression" || suffix?.type !== "call_suffix") return null;
  return suffix.startPosition.row > inner.endPosition.row ? inner : null;
}

/** The predicate arguments of a nest receiver, past the statement the grammar glued to it. */
function receiverPredicate(receiver: Node): Node {
  if (receiver.type !== "call_expression" || receiver.firstChild?.type !== "call_expression") return receiver;
  const suffix = receiver.lastChild;
  return suffix?.type === "call_suffix" && suffix.startPosition.row > receiver.firstChild.endPosition.row ? suffix : receiver;
}

/** `"/x".nest { }`, `("/x" and accept(JSON)).nest { }`, `nest("/x") { }`, `nest(path("/x")) { }`: the prefix, "" when the predicate has no path, null for no nest. */
function nestPrefixOf(call: Node): string | null {
  const head = call.firstChild;
  if (head?.type === "navigation_expression") {
    const suffix = head.namedChildren.find((c) => c.type === "navigation_suffix");
    if (suffix?.namedChildren.find((c) => c.type === "simple_identifier")?.text !== "nest") return null;
    return literalIn(receiverPredicate(head.firstChild!)) ?? "";
  }
  if (head?.type === "call_expression" && callee(head) === "nest") {
    return literalIn(head.descendantsOfType("value_arguments")[0] ?? head) ?? "";
  }
  if (head?.type === "simple_identifier" && head.text === "nest") {
    const args = call.descendantsOfType("value_arguments")[0];
    return args ? literalIn(args) ?? "" : null;
  }
  return null;
}
