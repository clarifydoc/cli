import type { Node } from "web-tree-sitter";
import type { RouteInfo, CallInfo, ParamInfo, RouteParamInfo } from "../../../../types/analysis.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { applyRouteMeta, buildAuth, type GuardAttr } from "../../../shared/route-metadata.js";
import { bindPhpParams, extractPhpRequestAccess, laravelGuard, requestReceivers } from "../request-access.js";

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
 *
 * Middleware is read from every place Laravel lets it be declared — the
 * fluent chain below the verb (`Route::middleware('auth')->get(…)`), above it
 * (`Route::get(…)->middleware('can:view,order')`), and every enclosing group
 * (`Route::middleware([…])->group(…)`, `Route::group(['middleware' => …])`).
 * Group middleware is inherited; chain middleware is the route's own. The
 * auth-flavoured strings (`auth:sanctum`, `role:admin`, `can:…`, `guest`)
 * become `auth`; the rest (`throttle:60,1`, `web`) stay plain middleware.
 *
 * A controller handler's parameters live in another file, so `params` are
 * left for the project-level join (`core/request-schemas.ts`, via the PHP
 * plugin's `bindParam` + `requestAccess`). A closure handler's signature and
 * body ARE in hand, so its params are emitted here.
 */

const LARAVEL_VERBS: ReadonlySet<string> = new Set([
  "get", "post", "put", "patch", "delete", "options", "any",
]);

/**
 * `Route::resource` expansion — Laravel's fixed CRUD action table; `{}` is
 * the resource's own parameter (`{album}`), `update` answers PUT and PATCH.
 */
const RESOURCE_ACTIONS: ReadonlyArray<{ action: string; methods: readonly string[]; suffix: string }> = [
  { action: "index", methods: ["GET"], suffix: "" },
  { action: "create", methods: ["GET"], suffix: "/create" },
  { action: "store", methods: ["POST"], suffix: "" },
  { action: "show", methods: ["GET"], suffix: "/{}" },
  { action: "edit", methods: ["GET"], suffix: "/{}/edit" },
  { action: "update", methods: ["PUT", "PATCH"], suffix: "/{}" },
  { action: "destroy", methods: ["DELETE"], suffix: "/{}" },
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
  return arrayKeyValues(node, key)[0] ?? null;
}

/**
 * Every string under a group-options key: `'middleware' => 'auth'` → [auth],
 * `'middleware' => ['auth', 'role:admin']` → both. Empty when absent.
 */
function arrayKeyValues(node: Node | undefined, key: string): string[] {
  if (!node || node.type !== "array_creation_expression") return [];
  for (const el of node.children) {
    if (el.type !== "array_element_initializer") continue;
    const parts = el.children.filter((c) => c.type !== "=>" && c.type !== ",");
    if (parts.length < 2 || stringValue(parts[0]) !== key) continue;
    const value = parts[1]!;
    const s = stringValue(value);
    if (s !== null) return [s];
    return arrayStrings(value);
  }
  return [];
}

/** String arguments of a `->middleware('a')` / `->middleware(['a', 'b'])` / `->middleware('a', 'b')` call. */
function middlewareArgs(call: Node): string[] {
  const out: string[] = [];
  for (const arg of callArgs(call)) {
    const s = stringValue(arg);
    if (s !== null) out.push(s);
    else out.push(...arrayStrings(arg));
  }
  return out;
}

// ─── Handler resolution ─────────────────────────────────────────────────────

interface Handler {
  name: string | null;
  calls: CallInfo[];
  /** The controller class as the route writes it (`Account\\ShowController`, `ShowController::class`). */
  controller?: { written: string; classConstant: boolean };
}

/** `ShowController::class` as written, for the route's qualified controller. */
function classConstantController(node: Node): { controller: { written: string; classConstant: true } } | Record<string, never> {
  const written = node.child(0)?.text;
  return written ? { controller: { written, classConstant: true } } : {};
}

const USE_MAPS = new WeakMap<object, Map<string, string>>();

/** The file's `use A\B\ShowController;` / `use A\B\Other as Alias;` imports: alias → qualified name. */
function fileUses(node: Node): Map<string, string> {
  const cached = USE_MAPS.get(node.tree);
  if (cached) return cached;
  const out = new Map<string, string>();
  for (const decl of node.tree.rootNode.descendantsOfType("namespace_use_clause")) {
    if (!decl) continue;
    const name = decl.namedChildren.find((c) => c.type === "qualified_name" || c.type === "name")?.text;
    if (!name) continue;
    const alias = decl.childForFieldName("alias")?.text ?? decl.namedChildren.filter((c) => c.type === "name").pop()?.text;
    out.set(alias && alias !== name ? alias : name.split("\\").pop()!, name.replace(/^\\/, ""));
  }
  USE_MAPS.set(node.tree, out);
  return out;
}

/**
 * The controller's fully qualified class: `X::class` through the file's `use`
 * imports, a `uses` string under the enclosing groups' `namespace`. Null when
 * neither says.
 */
function qualifiedController(call: Node, h: Handler, namespace: string | null): string | null {
  if (!h.controller) return null;
  // `'League\\Http\\…'` in a single-quoted string is one backslash per separator.
  const written = h.controller.written.replace(/\\\\/g, "\\");
  const { classConstant } = h.controller;
  if (written.startsWith("\\")) return written.slice(1);
  if (classConstant || !namespace) {
    const [head, ...rest] = written.split("\\");
    const used = fileUses(call).get(head!);
    if (used) return [used, ...rest].join("\\");
    return written.includes("\\") && classConstant ? written : null;
  }
  return `${namespace}\\${written}`;
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

  // Invokable controller: `Route::post('me', LoginController::class)` runs
  // its `__invoke`.
  if (node.type === "class_constant_access_expression") {
    const cls = classConstantName(node);
    return { name: cls ? `${cls}#__invoke` : null, calls: [], ...classConstantController(node) };
  }

  if (node.type === "array_creation_expression") {
    // Options array: `['uses' => 'AccountController@accounts', 'as' => 'accounts']`.
    const uses = arrayKeyValue(node, "uses");
    if (uses) {
      const m = uses.match(/^([\w\\]+)[@]([\w]+)$/) ?? uses.match(/^([\w\\]+)::([\w]+)$/);
      return { name: m ? `${m[1]!.split("\\").pop()}#${m[2]}` : uses.split("\\").pop()!, calls: [], ...(m ? { controller: { written: m[1]!, classConstant: false } } : {}) };
    }
    let cls: string | null = null;
    let clsNode: Node | null = null;
    let method: string | null = null;
    for (const el of node.children) {
      if (el.type !== "array_element_initializer") continue;
      for (const c of el.children) {
        if (c.type === "class_constant_access_expression" && !cls) {
          cls = classConstantName(c);
          clsNode = c;
        }
        if (c.type === "string" || c.type === "encapsed_string") method ??= stringValue(c);
      }
    }
    if (cls) return { name: method ? `${cls}#${method}` : cls, calls: [], ...(clsNode ? classConstantController(clsNode) : {}) };
    return { name: null, calls: [] };
  }

  const str = stringValue(node);
  if (str) {
    // Legacy `Controller@action` / `Controller::action` string handlers.
    const m = str.match(/^([\w\\]+)[@]([\w]+)$/) ?? str.match(/^([\w\\]+)::([\w]+)$/);
    if (m) return { name: `${m[1]!.split("\\").pop()}#${m[2]}`, calls: [], controller: { written: m[1]!, classConstant: false } };
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
 * Every `->middleware(…)` in the fluent chain BELOW a call, root-first:
 * `Route::middleware('a')->prefix('x')->middleware('b')->get(…)` → [a, b].
 * The chain root `Route::middleware(…)` is a scoped call and counts too.
 */
function chainMiddleware(call: Node): string[] {
  const found: string[][] = [];
  let cur: Node | null = call.childForFieldName("object");
  while (cur) {
    if (cur.type === "member_call_expression" || cur.type === "scoped_call_expression") {
      if (cur.childForFieldName("name")?.text === "middleware") found.unshift(middlewareArgs(cur));
      cur = cur.type === "member_call_expression" ? cur.childForFieldName("object") : null;
    } else {
      break;
    }
  }
  return found.flat();
}

/**
 * Every `->middleware(…)` chained ABOVE a call, up to the statement:
 * `Route::get(…)->name('x')->middleware('can:view,order')`. The verb call is
 * the `object` of the next member call, which is the `object` of the next…
 */
function trailingChainMiddleware(call: Node): string[] {
  const out: string[] = [];
  let cur: Node | null = call;
  while (cur.parent && cur.parent.type === "member_call_expression" && cur.parent.childForFieldName("object")?.id === cur.id) {
    cur = cur.parent;
    if (cur.childForFieldName("name")?.text === "middleware") out.push(...middlewareArgs(cur));
  }
  return out;
}

interface GroupScope {
  /** Path prefixes of the enclosing groups, outermost first. */
  prefixes: string[];
  /** Middleware of the enclosing groups, outermost first. */
  middleware: string[];
  /** Route-name prefixes of the enclosing groups (`'as' => 'clubs.'`, `->name('clubs.')`), outermost first. */
  names: string[];
  /** The controller namespace the groups state (`'namespace' => 'League\\Http\\Controllers'`), nested ones appended. */
  namespace: string | null;
}

/**
 * Compose the path prefix and middleware from every enclosing `Route::group` /
 * `Route::prefix(..)->group(..)` / `Route::middleware(..)->group(..)` closure,
 * outermost first. Climbs from the route call through each wrapping closure to
 * the group call that received it.
 */
function groupScopeOf(routeCall: Node): GroupScope {
  const prefixes: string[] = [];
  const middleware: string[] = [];
  const names: string[] = [];
  const namespaces: string[] = [];
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
          const options = callArgs(up).find((a) => a.type === "array_creation_expression");
          const p = arrayKeyValue(options, "prefix") ?? chainPrefix(up);
          if (p) prefixes.unshift(p);
          const n = arrayKeyValue(options, "as") ?? chainValue(up, "name") ?? chainValue(up, "as");
          if (n) names.unshift(n);
          const ns = arrayKeyValue(options, "namespace") ?? chainValue(up, "namespace");
          if (ns) namespaces.unshift(ns);
          // `['middleware' => …]` options and the `Route::middleware(…)->…->group(…)` chain both apply.
          middleware.unshift(...arrayKeyValues(options, "middleware"), ...chainMiddleware(up));
        }
        cur = up; // continue climbing from the group call itself
        continue;
      }
    }
    cur = cur.parent;
  }
  // A nested namespace is relative to its group's, unless rooted (`\\X`) or already under it.
  let namespace: string | null = null;
  for (const raw of namespaces) {
    const ns = raw.replace(/\\\\/g, "\\");
    const clean = ns.replace(/^\\/, "").replace(/\\$/, "");
    namespace = !namespace || ns.startsWith("\\") || clean.startsWith(namespace) ? clean : `${namespace}\\${clean}`;
  }
  return { prefixes, middleware, names, namespace };
}

/** The string argument of a `->name('x')`-style call in the chain BELOW a call (`Route::name('clubs.')->prefix(…)->group(…)`). */
function chainValue(call: Node, method: string): string | null {
  let cur: Node | null = call.type === "member_call_expression" ? call.childForFieldName("object") : null;
  while (cur && (cur.type === "member_call_expression" || cur.type === "scoped_call_expression")) {
    if (cur.childForFieldName("name")?.text === method) return stringValue(callArgs(cur)[0]);
    cur = cur.type === "member_call_expression" ? cur.childForFieldName("object") : null;
  }
  return null;
}

/** The name a route call is given: a trailing `->name('x')`, or `'as' => 'x'` in its action array. */
function ownRouteName(call: Node, action: Node | undefined): string | null {
  let cur: Node = call;
  while (cur.parent && cur.parent.type === "member_call_expression" && cur.parent.childForFieldName("object")?.id === cur.id) {
    cur = cur.parent;
    if (cur.childForFieldName("name")?.text === "name") return stringValue(callArgs(cur)[0]);
  }
  return arrayKeyValue(action, "as");
}

// ─── Route metadata: middleware, auth, closure params ───────────────────────

/**
 * Write middleware + auth onto a route. Every string goes to `middleware`
 * (inherited group ones first); only the auth-flavoured ones contribute to
 * `auth`, so a route guarded by nothing but `throttle:60,1` carries no
 * `auth` at all rather than an empty one.
 */
function applyMiddleware(route: RouteInfo, inherited: readonly string[], own: readonly string[]): void {
  if (inherited.length === 0 && own.length === 0) return;
  route.middleware = [...route.middleware, ...inherited, ...own];
  const guards = (list: readonly string[]): GuardAttr[] =>
    list.map(laravelGuard).filter((g): g is GuardAttr => g !== null);
  const auth = buildAuth(guards(inherited), guards(own));
  if (auth) route.auth = auth;
}

/** Closure handler parameters: `function (Request $request, $id) { … }` — signature + what the body reads. */
function closureParams(node: Node | undefined, path: string): RouteParamInfo[] {
  if (!node) return [];
  if (node.type !== "anonymous_function" && node.type !== "anonymous_function_creation_expression" && node.type !== "arrow_function") return [];
  const formal = node.childForFieldName("parameters") ?? node.children.find((c) => c.type === "formal_parameters");
  const params: ParamInfo[] = [];
  for (const p of formal?.children ?? []) {
    if (p.type !== "simple_parameter" && p.type !== "variadic_parameter") continue;
    const varNode = p.children.find((c) => c.type === "variable_name");
    const name = varNode?.text.replace(/^\$/, "");
    if (!name) continue;
    const typeNode = p.children.find((c) => /_type$/.test(c.type));
    const type = typeNode ? typeNode.text.replace(/^\?/, "").replace(/^\\/, "").replace(/.*\\/, "") : null;
    params.push({ name, type, defaultValue: null });
  }
  const out = bindPhpParams(params, path);
  const body = node.childForFieldName("body") ?? node.children.find((c) => c.type === "compound_statement");
  if (body) {
    const seen = new Set(out.map((p) => `${p.binding}:${p.name}`));
    for (const acc of extractPhpRequestAccess(body.text, requestReceivers(params))) {
      if (seen.has(`${acc.binding}:${acc.name}`)) continue;
      seen.add(`${acc.binding}:${acc.name}`);
      out.push({ ...acc, inferred: true });
    }
  }
  return out;
}

function joinPath(prefixes: string[], path: string): string {
  const parts = [...prefixes, path]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0);
  return "/" + parts.join("/");
}

// ─── Route emission ─────────────────────────────────────────────────────────

/**
 * A resource name as the path Laravel serves it under, and the parameter it
 * names a member by: `photos` → `photos` + `{photo}`; nested `albums.songs` →
 * `albums/{album}/songs` + `{song}`; `playlist-folders` → `{playlist_folder}`.
 */
function resourcePathOf(base: string): { path: string; param: string } {
  const segments = base.split(".");
  const paramOf = (seg: string): string => singular(seg.split("/").pop()!).replace(/-/g, "_");
  const path = segments.map((seg, i) => (i < segments.length - 1 ? `${seg}/{${paramOf(seg)}}` : seg)).join("/");
  return { path, param: paramOf(segments[segments.length - 1]!) };
}

/** English singular of a plain resource name (`categories` → `category`, `matches` → `match`, `statuses` → `status`). */
function singular(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(?:ss|sh|ch|x|z|us)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** `->only([...])` / `->except('show')` chained onto a resource registration. */
function resourceFilters(call: Node): { only: Set<string> | null; except: Set<string> } {
  let only: Set<string> | null = null;
  const except = new Set<string>();
  let cur: Node = call;
  while (cur.parent && cur.parent.type === "member_call_expression" && cur.parent.childForFieldName("object")?.id === cur.id) {
    cur = cur.parent;
    const name = cur.childForFieldName("name")?.text;
    if (name !== "only" && name !== "except") continue;
    const arg = callArgs(cur)[0];
    const actions = arg?.type === "array_creation_expression" ? arrayStrings(arg) : [stringValue(arg)].filter((v): v is string => !!v);
    if (name === "only") only = new Set(actions);
    else for (const a of actions) except.add(a);
  }
  return { only, except };
}

/** Chain root is the `Route` facade (`Route::middleware('a')->get(...)`). */
function chainRootIsRoute(call: Node): boolean {
  let cur: Node | null = call;
  while (cur && cur.type === "member_call_expression") {
    cur = cur.childForFieldName("object");
  }
  return cur?.type === "scoped_call_expression" && cur.childForFieldName("scope")?.text === "Route";
}

/** One pass of a `foreach` over a literal array: the loop variables and what they hold. */
type LoopBinding = Map<string, { text: string | null; node: Node | null }>;

/**
 * The passes of the `foreach` a route call sits in when it walks an array
 * literal the file assigns (`$endpoints = ['ping' => PingController::class, …]`,
 * reached directly or through a closure's `use`): one binding per entry, the
 * key variable to the entry's key, the value variable to its value. Null when
 * the call is in no such loop.
 */
function literalLoop(call: Node): LoopBinding[] | null {
  let loop: Node | null = call.parent;
  while (loop && loop.type !== "foreach_statement") loop = loop.parent;
  if (!loop) return null;
  const iterated = loop.namedChildren[0];
  const binding = loop.namedChildren[1];
  if (iterated?.type !== "variable_name" || !binding) return null;
  const keyVar = binding.type === "pair" ? binding.namedChildren[0]?.text : null;
  const valueVar = binding.type === "pair" ? binding.namedChildren[1]?.text : binding.type === "variable_name" ? binding.text : null;
  const literals = call.tree.rootNode.descendantsOfType("assignment_expression").filter(
    (a): a is Node => !!a && a.childForFieldName("left")?.text === iterated.text && a.childForFieldName("right")?.type === "array_creation_expression",
  );
  if (literals.length !== 1) return null;
  const out: LoopBinding[] = [];
  for (const el of literals[0]!.childForFieldName("right")!.namedChildren) {
    if (el.type !== "array_element_initializer") continue;
    const parts = el.namedChildren;
    const key = parts.length === 2 ? parts[0]! : null;
    const value = parts.length === 2 ? parts[1]! : parts[0] ?? null;
    const b: LoopBinding = new Map();
    if (keyVar) b.set(keyVar, { text: key ? stringValue(key) : null, node: key });
    if (valueVar) b.set(valueVar, { text: value ? stringValue(value) : null, node: value });
    out.push(b);
  }
  return out;
}

/** A route path with the loop's variables (`"{$endpoint}.view"`, `"$endpoint"`) filled in; null when one has no string value. */
function boundString(node: Node | undefined, bound: LoopBinding | undefined): string | null {
  const text = stringValue(node);
  if (text === null || !bound || node?.type !== "encapsed_string") return text;
  let missing = false;
  const out = text.replace(/\{(\$\w+)\}|(\$\w+)/g, (m, braced: string | undefined, bare: string | undefined) => {
    const v = bound.get((braced ?? bare)!);
    if (!v) return m;
    if (v.text === null) missing = true;
    return v.text ?? "";
  });
  return missing ? null : out;
}

function emitVerbRoute(
  call: Node,
  verb: string,
  rawArgs: Node[],
  routes: RouteInfo[],
  basePrefix: string,
  bound?: LoopBinding,
): void {
  // A loop variable handed as the handler (`$controller`) is the entry's value.
  const args = bound ? rawArgs.map((a) => (a.type === "variable_name" && bound.get(a.text)?.node) || a) : rawArgs;
  const stringValue = (node: Node | undefined): string | null => boundString(node, bound);
  const line = call.startPosition.row + 1;
  const scope = groupScopeOf(call);
  const prefixes = basePrefix ? [basePrefix, ...scope.prefixes] : scope.prefixes;
  const own = [...chainMiddleware(call), ...trailingChainMiddleware(call)];
  const named = (own: string | null): { name?: string } => (own ? { name: scope.names.join("") + own } : {});
  const ownerOf = (h: Handler): { owner?: string } => {
    const q = qualifiedController(call, h, scope.namespace);
    return q ? { owner: q } : {};
  };
  const emit = (r: RouteInfo, handlerArg?: Node): void => {
    applyMiddleware(r, scope.middleware, own);
    applyRouteMeta(r, { params: closureParams(handlerArg, r.path) });
    routes.push(r);
  };

  if (verb === "match") {
    // Route::match(['get','post'], '/multi', handler)
    const verbs = arrayStrings(args[0]).map((v) => v.toUpperCase());
    // `''` is the group prefix itself.
    const path = stringValue(args[1]);
    if (path === null) return;
    const h = resolveHandler(args[2]);
    const name = named(ownRouteName(call, args[2]));
    for (const m of verbs) {
      emit({ path: joinPath(prefixes, path), httpMethod: m, kind: "api", handler: h.name, calls: h.calls, middleware: [], line, ...name, ...ownerOf(h) }, args[2]);
    }
    return;
  }

  if (verb === "view") {
    // Route::view('/welcome', 'shop.catalog') — a GET that renders a named
    // Blade view. Emitted as a FRONTEND route whose componentPath is the
    // dotted view name as a /-path, so the screen builder's suffix resolver
    // anchors it to resources/views/shop/catalog.blade.php.
    const path = stringValue(args[0]);
    if (path === null) return;
    const view = stringValue(args[1]);
    emit({
      path: joinPath(prefixes, path),
      httpMethod: "GET",
      kind: "frontend",
      handler: view,
      componentPath: view ? "/" + view.replace(/\./g, "/") : null,
      calls: [],
      middleware: [],
      line,
      ...named(ownRouteName(call, undefined)),
    });
    return;
  }

  if (verb === "resource" || verb === "apiResource") {
    const base = stringValue(args[0]);
    if (!base) return;
    const ctlArg = args[1];
    const cls = ctlArg ? (classConstantName(ctlArg) ?? stringValue(ctlArg)?.split("\\").pop() ?? null) : null;
    const resourceOwner = ctlArg
      ? ownerOf(ctlArg.type === "class_constant_access_expression"
        ? { name: null, calls: [], ...classConstantController(ctlArg) }
        : { name: null, calls: [], ...(stringValue(ctlArg) ? { controller: { written: stringValue(ctlArg)!, classConstant: false } } : {}) })
      : {};
    const { only, except } = resourceFilters(call);
    const { path: resourcePath, param } = resourcePathOf(base);
    for (const a of RESOURCE_ACTIONS) {
      if (verb === "apiResource" && API_RESOURCE_SKIP.has(a.action)) continue;
      if ((only && !only.has(a.action)) || except.has(a.action)) continue;
      for (const method of a.methods) {
        emit({
          path: joinPath(prefixes, resourcePath) + a.suffix.replace("{}", `{${param}}`),
          httpMethod: method,
          kind: "api",
          handler: cls ? `${cls}#${a.action}` : a.action,
          calls: [],
          middleware: [],
          line,
          ...named(`${base}.${a.action}`),
          ...resourceOwner,
        });
      }
    }
    return;
  }

  // Plain verb: Route::get('/x', handler) — `any` dispatches all verbs (null).
  const path = stringValue(args[0]);
  if (path === null) return;
  const h = resolveHandler(args[1]);
  emit({
    path: joinPath(prefixes, path),
    httpMethod: verb === "any" ? null : verb.toUpperCase(),
    kind: "api",
    handler: h.name,
    calls: h.calls,
    middleware: [],
    line,
    ...named(ownRouteName(call, args[1])),
    ...ownerOf(h),
  }, args[1]);
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
    emitLooped(node, verb, routes, basePrefix);
    return;
  }

  // Route::middleware('auth')->get(...) — fluent chain ending in a verb.
  if (node.type === "member_call_expression") {
    const verb = node.childForFieldName("name")?.text ?? "";
    if (!ROUTE_CALL_NAMES.has(verb)) return;
    if (!chainRootIsRoute(node)) return;
    emitLooped(node, verb, routes, basePrefix);
  }
}

/** A route call, once per entry of the literal array a `foreach` around it walks. */
function emitLooped(node: Node, verb: string, routes: RouteInfo[], basePrefix: string): void {
  const passes = literalLoop(node);
  // Only a call that uses a loop variable differs from pass to pass.
  const uses = (b: LoopBinding) => [...b.keys()].some((v) => new RegExp(`\\${v}\\b`).test(node.text));
  if (!passes || passes.length === 0 || !uses(passes[0]!)) {
    emitVerbRoute(node, verb, callArgs(node), routes, basePrefix);
    return;
  }
  for (const bound of passes) emitVerbRoute(node, verb, callArgs(node), routes, basePrefix, bound);
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
