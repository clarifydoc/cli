import type { Node } from "web-tree-sitter";
import type { RouteInfo, RouteParamInfo } from "../../../../types/analysis.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { applyRouteMeta } from "../../../shared/route-metadata.js";

/**
 * Javalin and Spark (sparkjava) — the two Java micro-frameworks whose routes
 * are calls, not annotations, in Java and Kotlin:
 *
 *   app.get("/users/{id}", ctx -> ctx.json(repo.find(ctx.pathParam("id"))));
 *   app.post("/users", UserController::create);                // handler UserController.create
 *   app.routes(() -> {                                          // Javalin ApiBuilder
 *     path("api/users", () -> {
 *       get(UserController::getAll);                            // GET /api/users
 *       path("{id}", () -> get(UserController::getOne));        // GET /api/users/{id}
 *     });
 *     crud("orders/{order-id}", new OrderController());        // the five CRUD routes
 *   });
 *   get("/hello", (req, res) -> "hi");                          // Spark, statically imported
 *   path("/api", () -> post("/items", ItemRoutes::create));     // Spark path groups
 *   app.get("/k") { ctx -> … }                                  // Kotlin trailing lambda
 *
 * The verbs are generic names, so the walk runs only in a file importing
 * `io.javalin` or `spark.Spark`, and a call is a route only with a handler:
 * a receiver-less verb inside a `path(…)`/`routes(…)`/`apiBuilder(…)` block
 * (or anywhere in a Spark file, which imports them statically), and a
 * receiver verb whose path is a string and whose handler is a lambda, a
 * method reference or a `new` handler — `map.put("/x", value)` is not a route.
 * Javalin `<id>` path parameters are written `{id}`, as its `{id}` form is.
 */

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const BLOCKS = new Set(["path", "routes", "apiBuilder", "router"]);
type Framework = "javalin" | "spark";

/** What a handler body reads off the request: `ctx.pathParam("id")`, `req.queryParams("q")`, `ctx.bodyAsClass(User.class)`. */
export function javalinSparkAccess(text: string, name: string, framework: Framework): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const add = (p: RouteParamInfo) => {
    const key = `${p.binding}:${p.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  };
  const v = name.replace(/[$]/g, "\\$");
  if (framework === "javalin") {
    for (const m of text.matchAll(new RegExp(String.raw`\b${v}\.(pathParam|queryParam|header|formParam|cookie)(?:AsClass)?\s*(?:<[^>]*>)?\(\s*"([^"]+)"`, "g"))) {
      const binding = m[1] === "pathParam" ? "route" : m[1] === "queryParam" ? "query" : m[1] === "formParam" ? "form" : "header";
      add({ name: m[2]!, type: null, binding });
    }
    const body = new RegExp(String.raw`\b${v}\.(?:bodyAsClass|bodyValidator|bodyStreamAsClass)\s*(?:<\s*([\w.]+)\s*>\s*\(\s*\)|\(\s*([\w.]+)(?:::class(?:\.java)?|\.class))`).exec(text);
    if (body) add({ name: "body", type: (body[1] ?? body[2])!, binding: "body" });
    else if (new RegExp(String.raw`\b${v}\.body(?:AsBytes)?\(\s*\)`).test(text)) add({ name: "body", type: null, binding: "body" });
  } else {
    for (const m of text.matchAll(new RegExp(String.raw`\b${v}\.(params|queryParams|headers|cookie)\s*\(\s*"([^"]+)"`, "g"))) {
      const binding = m[1] === "params" ? "route" : m[1] === "queryParams" ? "query" : "header";
      add({ name: m[1] === "params" ? m[2]!.replace(/^:/, "") : m[2]!, type: null, binding });
    }
    if (new RegExp(String.raw`\b${v}\.body(?:AsBytes)?\(\s*\)`).test(text)) add({ name: "body", type: null, binding: "body" });
  }
  return out;
}

/** A Java `method_invocation` or Kotlin `call_expression`, read the same way. */
interface Call {
  node: Node;
  receiver: string | null;
  /** The receiver expression, which may hold routes of its own (`Javalin.create().get(…).post(…)`). */
  object: Node | null;
  name: string;
  args: Node[];
}

const unquote = (n: Node | undefined): string | null => {
  if (!n) return null;
  const s = n.type === "value_argument" ? n.namedChildren[0] : n;
  return s?.type === "string_literal" && !/\$\{|\$[A-Za-z]/.test(s.text) ? s.text.replace(/^"|"$/g, "") : null;
};

function readCall(n: Node): Call | null {
  if (n.type === "method_invocation") {
    const name = n.childForFieldName("name")?.text;
    if (!name) return null;
    const object = n.childForFieldName("object");
    return { node: n, receiver: object?.text ?? null, object, name, args: n.childForFieldName("arguments")?.namedChildren ?? [] };
  }
  if (n.type !== "call_expression") return null;
  // Kotlin `app.get("/x") { ctx -> … }`: the outer call carries the lambda of the inner one.
  const head = n.child(0);
  if (head?.type === "call_expression") return null;
  const suffix = n.namedChildren.find((c) => c.type === "call_suffix");
  const args = [...(suffix?.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren ?? [])];
  const outer = n.parent?.type === "call_expression" && n.parent.child(0)?.id === n.id ? n.parent : null;
  const lambda = (outer ?? n).namedChildren.find((c) => c.type === "call_suffix")?.namedChildren.find((c) => c.type === "annotated_lambda");
  if (lambda) args.push(lambda);
  if (head?.type === "simple_identifier") return { node: n, receiver: null, object: null, name: head.text, args };
  if (head?.type === "navigation_expression") {
    const name = head.namedChildren.find((c) => c.type === "navigation_suffix")?.text.replace(/^\??\./, "");
    const recv = head.namedChildren[0];
    return name ? { node: n, receiver: recv?.text ?? null, object: recv ?? null, name, args } : null;
  }
  return null;
}

const isHandler = (a: Node): boolean => {
  const n = a.type === "value_argument" ? a.namedChildren[0] : a;
  return !!n && /^(?:lambda_expression|method_reference|object_creation_expression|annotated_lambda|lambda_literal|callable_reference|anonymous_function)$/.test(n.type);
};
const isHandlerLike = (a: Node): boolean => {
  const n = a.type === "value_argument" ? a.namedChildren[0] : a;
  return isHandler(a) || n?.type === "identifier" || n?.type === "simple_identifier" || n?.type === "field_access" || n?.type === "navigation_expression";
};

/** `UserController::getOne` → `UserController.getOne`; `this::list` → `list`. */
function handlerName(a: Node): string | null {
  const n = a.type === "value_argument" ? a.namedChildren[0] : a;
  if (!n) return null;
  if (n.type === "method_reference" || n.type === "callable_reference") {
    const parts = n.namedChildren.map((c) => c.text);
    const method = parts[parts.length - 1]!;
    const owner = parts.length > 1 ? parts[0]! : "";
    return owner && owner !== "this" ? `${owner.replace(/^.*\./, "")}.${method}` : method;
  }
  return n.type === "identifier" || n.type === "simple_identifier" ? n.text : null;
}

/** The lambda's first parameter name (`ctx`, `req`) and its body. */
function lambdaOf(a: Node): { param: string | null; body: Node } | null {
  let n: Node | undefined | null = a.type === "value_argument" ? a.namedChildren[0] : a;
  if (n?.type === "annotated_lambda") n = n.namedChildren.find((c) => c.type === "lambda_literal");
  if (n?.type === "lambda_expression") {
    const p = n.namedChildren[0];
    const first = p?.type === "identifier" ? p.text : p?.type === "formal_parameters" || p?.type === "inferred_parameters" ? p.namedChildren[0]?.text.split(/\s+/).pop() ?? null : null;
    return { param: first, body: n };
  }
  if (n?.type === "lambda_literal") {
    const params = n.namedChildren.find((c) => c.type === "lambda_parameters");
    return { param: params?.namedChildren[0]?.text.split(":")[0]!.trim() ?? "it", body: n };
  }
  return null;
}

const joinPath = (prefixes: readonly string[], path: string): string => {
  const parts = [...prefixes, path].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return ("/" + parts.join("/")).replace(/<([^>]+)>/g, "{$1}");
};

export function extractJavalinSparkRoutes(root: Node, sourceText: string, routes: RouteInfo[]): void {
  const framework: Framework | null = /\bio\.javalin\b/.test(sourceText) ? "javalin" : /\bspark\.Spark\b|import\s+(?:static\s+)?spark\.\*/.test(sourceText) ? "spark" : null;
  if (!framework) return;
  const language = root.type === "source_file" ? "kotlin" : "java";

  const emit = (call: Call, method: string, path: string, handlerArg: Node | undefined, extra: Partial<RouteInfo> = {}) => {
    const lambda = handlerArg ? lambdaOf(handlerArg) : null;
    const route: RouteInfo = {
      path,
      httpMethod: method,
      kind: "api",
      handler: lambda ? null : handlerArg ? handlerName(handlerArg) : null,
      calls: lambda ? extractCalls(lambda.body, language) : [],
      middleware: [],
      line: call.node.startPosition.row + 1,
      ...extra,
    };
    const params: RouteParamInfo[] = [];
    for (const m of path.matchAll(/\{([^}]+)\}|:(\w+)/g)) params.push({ name: (m[1] ?? m[2])!, type: null, binding: "route" });
    if (lambda?.param) for (const p of javalinSparkAccess(lambda.body.text, lambda.param, framework)) if (!params.some((q) => q.binding === p.binding && q.name === p.name)) params.push(p);
    applyRouteMeta(route, { params: params.map((p) => ({ ...p, inferred: true })) });
    routes.push(route);
  };

  const visit = (n: Node, prefixes: string[], inBlock: boolean): void => {
    // A Kotlin trailing-lambda wrapper: its inner call reads the lambda as an argument.
    if (n.type === "call_expression" && n.child(0)?.type === "call_expression") {
      visit(n.child(0)!, prefixes, inBlock);
      return;
    }
    const call = readCall(n);
    if (call) {
      if (call.object) visit(call.object, prefixes, inBlock);
      const verb = VERBS.has(call.name) ? call.name : null;
      const path = unquote(call.args[0]);
      // `path("users", () -> { … })`, `app.routes(() -> …)`: what the block registers sits under it.
      if (BLOCKS.has(call.name) && (call.receiver === null || call.name !== "path")) {
        const next = call.name === "path" && path !== null ? [...prefixes, path] : prefixes;
        for (const a of call.args) visit(a, next, true);
        return;
      }
      if (verb) {
        const rest = path !== null ? call.args.slice(1) : call.args;
        const handler = rest.find(isHandler) ?? rest.find(isHandlerLike);
        // Receiver-less verbs are the DSL's inside a block (and Spark's static imports anywhere);
        // a receiver verb needs a real handler — a lambda, a method reference, a `new` one.
        const anchored = call.receiver === null ? inBlock || framework === "spark" : rest.some(isHandler);
        if (anchored && handler && (path !== null || inBlock)) {
          emit(call, verb.toUpperCase(), joinPath(prefixes, path ?? ""), handler);
          return;
        }
      } else if (call.name === "crud" && framework === "javalin" && path !== null) {
        // ApiBuilder `crud("users/{user-id}", controller)`: getAll/create on the collection, getOne/update/delete on the item.
        const full = joinPath(prefixes, path);
        const collection = full.replace(/\/\{[^}]+\}$/, "");
        const ctrl = call.args[1]?.type === "value_argument" ? call.args[1].namedChildren[0] : call.args[1];
        const controller = ctrl?.type === "object_creation_expression" ? ctrl.childForFieldName("type")?.text ?? null : ctrl?.type === "call_expression" ? ctrl.child(0)?.text ?? null : null;
        const h = (m: string) => (controller ? { handler: `${controller}.${m}` } : {});
        emit(call, "GET", collection, undefined, h("getAll"));
        emit(call, "POST", collection, undefined, h("create"));
        emit(call, "GET", full, undefined, h("getOne"));
        emit(call, "PATCH", full, undefined, h("update"));
        emit(call, "DELETE", full, undefined, h("delete"));
        return;
      }
      for (const a of call.args) visit(a, prefixes, inBlock);
      return;
    }
    for (const c of n.namedChildren) visit(c, prefixes, inBlock);
  };
  visit(root, [], false);
}
