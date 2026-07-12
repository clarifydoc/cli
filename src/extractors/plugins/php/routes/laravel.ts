import type { Node } from "web-tree-sitter";
import type { RouteInfo, CallInfo } from "../../../../types/analysis.js";
import { extractCalls } from "../../../shared/call-graph.js";

/**
 * Laravel `Route::` facade routing (routes/web.php, routes/api.php).
 *
 * Laravel declares routes as facade calls instead of controller conventions:
 *
 *   Route::get('/users/{id}', [UserController::class, 'show']);
 *   Route::post('/users', 'UserController@store');
 *   Route::resource('photos', PhotoController::class);          // 7 CRUD routes
 *   Route::group(['prefix' => 'admin'], function () { ... });   // path prefix
 *   Route::prefix('api')->group(function () { ... });           // fluent prefix
 *   Route::middleware('auth')->get('/me', fn () => ...);        // fluent verb
 *
 * Without this extractor a Laravel backend contributes zero `api` routes, so
 * every frontend `axios.get('/api/users')` dead-ends and apiRouteLinks stays
 * empty — the same failure CodeIgniter had before its convention extractor.
 *
 * Handlers are emitted in the linker's resolved `Controller#action` form (the
 * `[Controller::class, 'action']` tuple and the legacy `Controller@action`
 * string both normalize to it); closure handlers stay null but contribute
 * their body's calls so traces can continue through helper functions.
 */

const LARAVEL_VERBS: ReadonlySet<string> = new Set([
  "get", "post", "put", "patch", "delete", "options", "any",
]);

/** `Route::resource` expansion — Laravel's fixed CRUD action table. */
const RESOURCE_ACTIONS: ReadonlyArray<{ action: string; method: string; suffix: string }> = [
  { action: "index", method: "GET", suffix: "" },
  { action: "create", method: "GET", suffix: "/create" },
  { action: "store", method: "POST", suffix: "" },
  { action: "show", method: "GET", suffix: "/{id}" },
  { action: "edit", method: "GET", suffix: "/{id}/edit" },
  { action: "update", method: "PUT", suffix: "/{id}" },
  { action: "destroy", method: "DELETE", suffix: "/{id}" },
];
/** `Route::apiResource` omits the HTML form endpoints. */
const API_RESOURCE_SKIP = new Set(["create", "edit"]);

// ─── Argument helpers ───────────────────────────────────────────────────────

/** The `argument` children of a call's `arguments` node, unwrapped. */
function callArgs(call: Node): Node[] {
  const args = call.childForFieldName("arguments");
  if (!args) return [];
  const out: Node[] = [];
  for (const a of args.children) {
    if (a.type !== "argument") continue;
    const inner = a.children.find((c) => c.type !== "," && c.type !== "(" && c.type !== ")");
    if (inner) out.push(inner);
  }
  return out;
}

function stringValue(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "string" || node.type === "encapsed_string") {
    return node.text.replace(/^['"]|['"]$/g, "");
  }
  return null;
}

/** Every string element of an inline `['get', 'post']` array. */
function arrayStrings(node: Node | undefined): string[] {
  if (!node || node.type !== "array_creation_expression") return [];
  const out: string[] = [];
  for (const el of node.children) {
    if (el.type !== "array_element_initializer") continue;
    const s = el.children.find((c) => c.type === "string" || c.type === "encapsed_string");
    const v = stringValue(s);
    if (v) out.push(v);
  }
  return out;
}

/** `'prefix' => 'admin'` value from a group-options array, null if absent. */
function arrayKeyValue(node: Node | undefined, key: string): string | null {
  if (!node || node.type !== "array_creation_expression") return null;
  for (const el of node.children) {
    if (el.type !== "array_element_initializer") continue;
    const strs = el.children.filter((c) => c.type === "string" || c.type === "encapsed_string");
    if (strs.length >= 2 && stringValue(strs[0]) === key) return stringValue(strs[1]);
  }
  return null;
}

// ─── Handler resolution ─────────────────────────────────────────────────────

interface Handler {
  name: string | null;
  calls: CallInfo[];
}

/** Bare class name from `UserController::class` / `Some\Ns\UserController::class`. */
function classConstantName(node: Node): string | null {
  if (node.type !== "class_constant_access_expression") return null;
  const first = node.child(0);
  if (!first) return null;
  return first.text.split("\\").pop() ?? null;
}

/**
 * Resolve a route's handler argument:
 *   `[UserController::class, 'show']` → `UserController#show`
 *   `'UserController@show'`           → `UserController#show`
 *   closure / arrow fn                → null handler + the body's calls
 */
function resolveHandler(node: Node | undefined): Handler {
  if (!node) return { name: null, calls: [] };

  if (node.type === "array_creation_expression") {
    let cls: string | null = null;
    let method: string | null = null;
    for (const el of node.children) {
      if (el.type !== "array_element_initializer") continue;
      for (const c of el.children) {
        if (c.type === "class_constant_access_expression") cls ??= classConstantName(c);
        if (c.type === "string" || c.type === "encapsed_string") method ??= stringValue(c);
      }
    }
    if (cls) return { name: method ? `${cls}#${method}` : cls, calls: [] };
    return { name: null, calls: [] };
  }

  const str = stringValue(node);
  if (str) {
    // Legacy `Controller@action` / `Controller::action` string handlers.
    const m = str.match(/^([\w\\]+)[@]([\w]+)$/) ?? str.match(/^([\w\\]+)::([\w]+)$/);
    if (m) return { name: `${m[1]!.split("\\").pop()}#${m[2]}`, calls: [] };
    return { name: str, calls: [] };
  }

  if (node.type === "anonymous_function" || node.type === "anonymous_function_creation_expression" || node.type === "arrow_function") {
    const body = node.childForFieldName("body") ?? node.children.find((c) => c.type === "compound_statement");
    return { name: null, calls: body ? extractCalls(body, "php") : [] };
  }

  return { name: null, calls: [] };
}

// ─── Group-prefix composition ───────────────────────────────────────────────

/** First string argument of a call named `prefix` anywhere in a fluent chain. */
function chainPrefix(call: Node): string | null {
  let cur: Node | null = call;
  while (cur) {
    if (cur.type === "member_call_expression" || cur.type === "scoped_call_expression") {
      if (cur.childForFieldName("name")?.text === "prefix") {
        return stringValue(callArgs(cur)[0]);
      }
      cur = cur.type === "member_call_expression" ? cur.childForFieldName("object") : null;
    } else {
      break;
    }
  }
  return null;
}

/**
 * Compose the path prefix from every enclosing `Route::group` /
 * `Route::prefix(..)->group(..)` closure, outermost first. Climbs from the
 * route call through each wrapping closure to the group call that received it.
 */
function groupPrefixOf(routeCall: Node): string[] {
  const prefixes: string[] = [];
  let cur: Node | null = routeCall.parent;
  while (cur) {
    if (cur.type === "anonymous_function" || cur.type === "anonymous_function_creation_expression" || cur.type === "arrow_function") {
      // The closure is an argument of some call — find that call.
      let up: Node | null = cur.parent;
      while (up && up.type !== "member_call_expression" && up.type !== "scoped_call_expression" && up.type !== "function_call_expression") {
        up = up.parent;
      }
      if (up && (up.type === "member_call_expression" || up.type === "scoped_call_expression")) {
        const callName = up.childForFieldName("name")?.text;
        if (callName === "group") {
          const p =
            arrayKeyValue(callArgs(up).find((a) => a.type === "array_creation_expression"), "prefix") ??
            chainPrefix(up);
          if (p) prefixes.unshift(p);
        }
        cur = up; // continue climbing from the group call itself
        continue;
      }
    }
    cur = cur.parent;
  }
  return prefixes;
}

function joinPath(prefixes: string[], path: string): string {
  const parts = [...prefixes, path]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0);
  return "/" + parts.join("/");
}

// ─── Route emission ─────────────────────────────────────────────────────────

/** Chain root is the `Route` facade (`Route::middleware('a')->get(...)`). */
function chainRootIsRoute(call: Node): boolean {
  let cur: Node | null = call;
  while (cur && cur.type === "member_call_expression") {
    cur = cur.childForFieldName("object");
  }
  return cur?.type === "scoped_call_expression" && cur.childForFieldName("scope")?.text === "Route";
}

function emitVerbRoute(
  call: Node,
  verb: string,
  args: Node[],
  routes: RouteInfo[],
  basePrefix: string,
): void {
  const line = call.startPosition.row + 1;
  const prefixes = basePrefix ? [basePrefix, ...groupPrefixOf(call)] : groupPrefixOf(call);

  if (verb === "match") {
    // Route::match(['get','post'], '/multi', handler)
    const verbs = arrayStrings(args[0]).map((v) => v.toUpperCase());
    const path = stringValue(args[1]);
    if (!path) return;
    const h = resolveHandler(args[2]);
    for (const m of verbs) {
      routes.push({ path: joinPath(prefixes, path), httpMethod: m, kind: "api", handler: h.name, calls: h.calls, middleware: [], line });
    }
    return;
  }

  if (verb === "view") {
    // Route::view('/welcome', 'shop.catalog') — a GET that renders a named
    // Blade view. Emitted as a FRONTEND route whose componentPath is the
    // dotted view name as a /-path, so the screen builder's suffix resolver
    // anchors it to resources/views/shop/catalog.blade.php.
    const path = stringValue(args[0]);
    if (!path) return;
    const view = stringValue(args[1]);
    routes.push({
      path: joinPath(prefixes, path),
      httpMethod: "GET",
      kind: "frontend",
      handler: view,
      componentPath: view ? "/" + view.replace(/\./g, "/") : null,
      calls: [],
      middleware: [],
      line,
    });
    return;
  }

  if (verb === "resource" || verb === "apiResource") {
    const base = stringValue(args[0]);
    if (!base) return;
    const ctlArg = args[1];
    const cls = ctlArg ? (classConstantName(ctlArg) ?? stringValue(ctlArg)?.split("\\").pop() ?? null) : null;
    for (const a of RESOURCE_ACTIONS) {
      if (verb === "apiResource" && API_RESOURCE_SKIP.has(a.action)) continue;
      routes.push({
        path: joinPath(prefixes, base) + a.suffix,
        httpMethod: a.method,
        kind: "api",
        handler: cls ? `${cls}#${a.action}` : a.action,
        calls: [],
        middleware: [],
        line,
      });
    }
    return;
  }

  // Plain verb: Route::get('/x', handler) — `any` dispatches all verbs (null).
  const path = stringValue(args[0]);
  if (!path) return;
  const h = resolveHandler(args[1]);
  routes.push({
    path: joinPath(prefixes, path),
    httpMethod: verb === "any" ? null : verb.toUpperCase(),
    kind: "api",
    handler: h.name,
    calls: h.calls,
    middleware: [],
    line,
  });
}

const ROUTE_CALL_NAMES: ReadonlySet<string> = new Set([
  ...LARAVEL_VERBS, "match", "view", "resource", "apiResource",
]);

/** Per-node visitor — Laravel `Route::` declarations (facade + fluent chains). */
export function visitLaravelRoute(node: Node, routes: RouteInfo[], basePrefix = ""): void {
  // Route::get(...) / Route::resource(...) — direct facade call.
  if (node.type === "scoped_call_expression") {
    if (node.childForFieldName("scope")?.text !== "Route") return;
    const verb = node.childForFieldName("name")?.text ?? "";
    if (!ROUTE_CALL_NAMES.has(verb)) return;
    emitVerbRoute(node, verb, callArgs(node), routes, basePrefix);
    return;
  }

  // Route::middleware('auth')->get(...) — fluent chain ending in a verb.
  if (node.type === "member_call_expression") {
    const verb = node.childForFieldName("name")?.text ?? "";
    if (!ROUTE_CALL_NAMES.has(verb)) return;
    if (!chainRootIsRoute(node)) return;
    emitVerbRoute(node, verb, callArgs(node), routes, basePrefix);
  }
}

/**
 * Full-tree walk (used by the PHP route extractor's entry point).
 * `basePrefix` carries Laravel's routes/api.php convention: the framework
 * mounts that file under `/api` (RouteServiceProvider), so the prefix never
 * appears in the file itself.
 */
export function extractLaravelRoutes(root: Node, routes: RouteInfo[], basePrefix = ""): void {
  const walk = (n: Node): void => {
    visitLaravelRoute(n, routes, basePrefix);
    for (const c of n.children) walk(c);
  };
  walk(root);
}
