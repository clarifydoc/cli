import type { Node } from "web-tree-sitter";
import type { RouteInfo, CallInfo, ParamInfo, RouteParamInfo, RouteResponseInfo } from "../../../../types/analysis.js";
import { responsesOf } from "../responses.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { applyRouteMeta, buildAuth, pathParamNames, type GuardAttr } from "../../../shared/route-metadata.js";
import { HTTP_METHODS, collectCallNames } from "../../../routes/base.js";
import { scanRequestAccess } from "../request-access.js";

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

const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "function"]);

/**
 * A middleware name that guards access rather than parsing, logging or
 * validating. Matched against the readable text of the argument
 * (`requireAuth`, `auth.required`, `ensureLoggedIn()`, `checkJwt`).
 */
const AUTH_IDIOM = /auth|guard|protect|permission|permit|role|admin|jwt|session|login|verify|ensure|require|isLogged|allow/i;
/** A call whose string arguments name roles: `authorize('admin')`, `requireRole('editor')`, `permit('staff')`. */
const ROLE_CALLEE = /role|authorize|permit/i;

/** Collapse whitespace so a multi-line `passport.authenticate(...)` reads as one string. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** String literal arguments of a call (`authorize('a', 'b')` → a, b); null when any argument is not a string. */
function stringArgs(call: Node): string[] | null {
  const args = call.childForFieldName("arguments");
  if (!args) return null;
  const out: string[] = [];
  for (const a of args.namedChildren) {
    if (a.type === "string" || a.type === "template_string") out.push(stripQuotes(a.text));
    else if (a.type === "object") continue; // `passport.authenticate('jwt', { session: false })`
    else return null;
  }
  return out;
}

/**
 * What one middleware argument says about access, or null when it is not an
 * auth idiom (`express.json()`, `validate(schema)`, `upload.single('f')`).
 * Exported for the router-level `use` pass.
 */
export function guardFromMiddleware(arg: Node): GuardAttr | null {
  const text = collapse(arg.text);
  if (arg.type === "call_expression") {
    const callee = arg.childForFieldName("function")?.text ?? "";
    const strings = stringArgs(arg);
    // `passport.authenticate('jwt', …)` / `authenticate('local')` — the mechanism.
    if (/(^|\.)authenticate$/.test(callee)) {
      return { text, schemes: strings?.length ? strings : [], policies: strings?.length ? [] : [callee] };
    }
    if (!AUTH_IDIOM.test(callee)) return null;
    if (ROLE_CALLEE.test(callee) && strings && strings.length > 0) return { text, roles: strings };
    return { text, policies: [callee] };
  }
  if (arg.type === "identifier" || arg.type === "member_expression") {
    return AUTH_IDIOM.test(text) ? { text, policies: [text] } : null;
  }
  return null;
}

/** multer: `upload.single('avatar')` / `upload.array('photos')` / `upload.fields([{ name: 'a' }])` → form fields. */
function formFieldsFromMiddleware(arg: Node): string[] {
  if (arg.type !== "call_expression") return [];
  const callee = arg.childForFieldName("function");
  if (callee?.type !== "member_expression") return [];
  const method = callee.childForFieldName("property")?.text;
  const args = arg.childForFieldName("arguments");
  if (!args) return [];
  if (method === "single" || method === "array") {
    const first = args.namedChildren[0];
    return first && first.type === "string" ? [stripQuotes(first.text)] : [];
  }
  if (method === "fields") {
    return [...arg.text.matchAll(/name\s*:\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2]!);
  }
  return [];
}

/** The handler function's request-object parameter: the first parameter when it is a plain identifier. */
function requestParamName(fn: Node): string | null {
  const params = fn.childForFieldName("parameters");
  if (!params) {
    // `req => …` — a single bare identifier parameter.
    const single = fn.childForFieldName("parameter");
    return single?.type === "identifier" ? single.text : null;
  }
  const first = params.namedChildren[0];
  if (!first) return null;
  const ident = first.type === "identifier" ? first : first.childForFieldName("pattern");
  return ident?.type === "identifier" ? ident.text : null;
}

/** An inline handler's parameter names, as the response reader needs them (`(req, res)`, `(c)`). */
function handlerParamNames(fn: Node): ParamInfo[] {
  const params = fn.childForFieldName("parameters");
  const single = fn.childForFieldName("parameter");
  const nodes = params ? params.namedChildren : single ? [single] : [];
  return nodes.map((p) => {
    const ident = p.type === "identifier" ? p : p.childForFieldName("pattern");
    return { name: ident?.type === "identifier" ? ident.text : "", type: null, defaultValue: null };
  });
}

const VALIDATOR_RE = /valid|zod|schema|celebrate/i;
const BODY_PARTS = new Set(["json", "form", "body"]);

/**
 * The schema a validating middleware checks the body against:
 * `validate(createUser)`, `validateBody(schema)`, Hono's
 * `zValidator("json", schema)`, `validateRequest({ body: schema })`.
 */
function validatedBody(m: Node): string | null {
  if (m.type !== "call_expression") return null;
  const callee = m.childForFieldName("function")?.text ?? "";
  if (!VALIDATOR_RE.test(callee.split(".").pop() ?? "")) return null;
  const args = m.childForFieldName("arguments")?.namedChildren ?? [];
  const [a, b] = args;
  if (a?.type === "identifier" && args.length === 1) return a.text;
  if (a?.type === "string" && BODY_PARTS.has(stripQuotes(a.text)) && b?.type === "identifier") return b.text;
  if (a?.type === "object") {
    for (const pair of a.namedChildren) {
      if (pair.type === "pair" && pair.childForFieldName("key")?.text === "body" && pair.childForFieldName("value")?.type === "identifier") return pair.childForFieldName("value")!.text;
    }
  }
  return null;
}

/** `schema.parse(req.body)` (or `safeParse`, `parseAsync`, `await c.req.json()`) in the handler: the body's schema. */
function parsedBody(fn: Node): string | null {
  return /\b([A-Za-z_$][\w$]*)\.(?:parse|safeParse|parseAsync|safeParseAsync)\(\s*(?:await\s+)?(?:req|request|ctx\.request|c\.req)\.(?:body\b|json\(\s*\))/.exec(fn.text)?.[1] ?? null;
}

/**
 * Parameters of an inline handler: the path's tokens (`/:id` → route), then
 * whatever the body reads off the request object, then multer form fields.
 * All inferred — nothing in Express declares a binding.
 */
function inlineHandlerParams(path: string, fn: Node, formFields: readonly string[]): RouteParamInfo[] {
  const params: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const add = (p: RouteParamInfo): void => {
    const key = `${p.binding}:${p.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    params.push({ ...p, inferred: true });
  };
  for (const name of pathParamNames(path)) add({ name, type: null, binding: "route" });
  const reqName = requestParamName(fn);
  if (reqName) for (const acc of scanRequestAccess(fn.text, reqName)) add(acc);
  for (const f of formFields) add({ name: f, type: null, binding: "form" });
  return params;
}

/** Per-route facts the router-level `use` pass needs, kept off the public RouteInfo. */
interface ExpressRouteMeta {
  receiver: string | null;
  guards: GuardAttr[];
  params: RouteParamInfo[];
  /** Guards on the same-file mounts this route was composed through (`app.use("/admin", requireAdmin, admin)`). */
  mountGuards?: GuardAttr[];
}
const routeMeta = new WeakMap<RouteInfo, ExpressRouteMeta>();

/**
 * Express-style: app.get("/path", handler). Runs the per-node visitor over
 * the tree and then the router-level guard pass.
 */
export function extractExpressRoutes(root: Node, routes: RouteInfo[]): void {
  walkForRoutes(root, routes);
  applyRouterLevelGuards(root, routes);
}

function walkForRoutes(node: Node, routes: RouteInfo[]) {
  visitExpressRoute(node, routes);
  for (const child of node.children) {
    walkForRoutes(child, routes);
  }
}

/**
 * Inspect a single node for an Express-style route registration. Routes
 * pushed here carry no `auth`/`params` yet — `applyRouterLevelGuards` must
 * run once over the same tree afterwards to write them (it needs every
 * `router.use(guard)` in the file, which a per-node visit cannot see).
 */
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
            // Everything after the path, with `[a, b]` middleware arrays flattened.
            const rest: Node[] = [];
            for (const arg of args.namedChildren.slice(1)) {
              if (arg.type === "array") rest.push(...arg.namedChildren);
              else rest.push(arg);
            }
            // A handler wrapped in an error/async adapter — `asyncHandler(async (req, res) => …)`,
            // `wrap(getUsers)`, `catchAsync(ctrl.list)` — is the function it wraps.
            const wrapped = rest.length > 0 ? unwrapHandler(rest[rest.length - 1]!) : null;
            if (wrapped) rest[rest.length - 1] = wrapped;
            const last = rest[rest.length - 1];
            const lastArgIsFn = !!last && FUNCTION_NODE_TYPES.has(last.type);

            // The last argument is the handler: an inline function, or the
            // identifier of one declared elsewhere. Everything before it is
            // middleware — including the guards that used to be mistaken for
            // the handler (`router.get('/', requireAuth, async (req, res) => …)`).
            let handler: string | null = null;
            let middlewareNodes: Node[] = [];
            if (lastArgIsFn) {
              middlewareNodes = rest.slice(0, -1);
            } else if (last && (last.type === "identifier" || last.type === "member_expression")) {
              handler = last.text;
              middlewareNodes = rest.slice(0, -1);
            }

            // Middleware in source order; the auth idioms among them also
            // become guards for `auth`.
            const middleware: string[] = [];
            const guards: GuardAttr[] = [];
            const formFields: string[] = [];
            for (const m of middlewareNodes) {
              if (m.type !== "identifier" && m.type !== "member_expression" && m.type !== "call_expression") continue;
              middleware.push(collapse(m.text));
              const guard = guardFromMiddleware(m);
              if (guard) guards.push(guard);
              formFields.push(...formFieldsFromMiddleware(m));
            }

            // Params only for an inline handler. An identifier handler is
            // declared elsewhere: the project-level join fills `params` from
            // that function's `requestAccess`, and only when none are set here.
            let calls: CallInfo[] = [];
            let params: RouteParamInfo[] = [];
            let responses: RouteResponseInfo[] | undefined;
            if (lastArgIsFn) {
              calls = collectCallNames(last!);
              params = inlineHandlerParams(path, last!, formFields);
              responses = responsesOf(handlerParamNames(last!), last!.childForFieldName("body"));
            }
            // The schema the body is validated with names its type (a zod schema, a DTO).
            const bodySchema = middlewareNodes.map(validatedBody).find(Boolean) ?? (lastArgIsFn ? parsedBody(last!) : null);
            if (bodySchema) {
              if (params.length === 0) params = [...pathParamNames(path)].map((name) => ({ name, type: null, binding: "route" as const, inferred: true }));
              params = [{ name: "body", type: bodySchema, binding: "body", inferred: true }, ...params.filter((p) => !(p.binding === "body" && p.name === "body"))];
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
              const route: RouteInfo = {
                path,
                httpMethod: method === "use" ? null : method.toUpperCase(),
                kind: "api",
                handler,
                calls,
                middleware,
                line: node.startPosition.row + 1,
                ...(responses ? { responses } : {}),
              };
              if (method === "use") route.mount = true;
              routeMeta.set(route, { receiver, guards, params });
              routes.push(route);
            }
          }
        }
      }
    }
  }
}

/**
 * `router.use(requireAuth)` / `app.use(passport.authenticate('jwt'))` with no
 * path guards every route registered on that receiver LATER in the file —
 * Express runs middleware in registration order. Collected from the file's
 * top-level statements, then written onto each route together with its own
 * guards and params. Non-auth `use` middleware (`express.json()`, `cors()`)
 * is deliberately not inherited: it says nothing about access.
 */
export function applyRouterLevelGuards(root: Node, routes: RouteInfo[]): void {
  composeLocalMounts(routes);
  const routerGuards: Array<{ receiver: string; line: number; guard: GuardAttr }> = [];
  for (const stmt of root.namedChildren) {
    const call = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
    if (!call || call.type !== "call_expression") continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "use") continue;
    const receiver = receiverName(fn);
    if (!receiver || NON_ROUTER_RECEIVERS.has(receiver)) continue;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    if (args.length === 0 || args[0]!.type === "string" || args[0]!.type === "template_string") continue;
    for (const arg of args) {
      const guard = guardFromMiddleware(arg);
      if (guard) routerGuards.push({ receiver, line: call.startPosition.row + 1, guard });
    }
  }

  for (const route of routes) {
    const meta = routeMeta.get(route);
    if (!meta) continue;
    routeMeta.delete(route);
    const inherited = routerGuards
      .filter((g) => g.receiver === meta.receiver && g.line < route.line)
      .map((g) => g.guard);
    // Middleware keeps source order (router-level first, then the route's own
    // arguments as written), so `applyRouteMeta` is used only for params; the
    // auth merge is the same `buildAuth` it would call.
    if (inherited.length > 0) route.middleware = [...inherited.map((g) => g.text), ...route.middleware];
    const auth = buildAuth([...(meta.mountGuards ?? []), ...inherited], meta.guards);
    if (auth) route.auth = auth;
    applyRouteMeta(route, { params: meta.params });
  }
}

/** Names of the adapters a handler is commonly wrapped in: `asyncHandler`, `catchAsync`, `wrap`, `tryCatch`. */
const HANDLER_WRAPPER = /handler|wrap|async|catch|safe|try|controller|route/i;

/**
 * The function a wrapped handler stands for: the inline function of
 * `asyncHandler(async (req, res) => …)`, or the identifier of `wrap(getUsers)`
 * when the wrapper is named like one. A call that wraps nothing — a guard
 * factory such as `passport.authenticate('jwt')` — is returned as null.
 */
function unwrapHandler(node: Node): Node | null {
  if (node.type !== "call_expression") return null;
  const callee = node.childForFieldName("function");
  const name = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : callee?.text;
  const args = node.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];
  if (args.length !== 1) return null;
  const inner = args[0]!;
  if (FUNCTION_NODE_TYPES.has(inner.type)) return inner;
  if ((inner.type === "identifier" || inner.type === "member_expression") && !!name && HANDLER_WRAPPER.test(name)) return inner;
  if (inner.type === "call_expression") return unwrapHandler(inner);
  return null;
}

/**
 * Routers mounted in the file that declares them: `const api = Router();
 * api.get("/users", …); app.use("/api", api)`. The project mount pass joins a
 * router across files only, so a same-file mount used to stay a method-less row
 * while its routes kept their unprefixed paths. Here each route declared on a
 * locally mounted receiver takes the mount's prefix (through any chain of
 * local mounts) and its guards, and the mount row goes.
 */
function composeLocalMounts(routes: RouteInfo[]): void {
  const receivers = new Set<string>();
  // A receiver is a local router when routes OR mounts are registered on it:
  // `apiRouter.use("/users", usersRouter)` makes `apiRouter` one even with no route of its own.
  for (const r of routes) {
    const recv = routeMeta.get(r)?.receiver;
    if (recv) receivers.add(recv);
  }
  const byTarget = new Map<string, RouteInfo[]>();
  for (const r of routes) {
    if (!r.mount || !r.handler || !/^[A-Za-z_$][\w$]*$/.test(r.handler)) continue;
    const target = r.handler.toLowerCase();
    if (!receivers.has(target) || target === routeMeta.get(r)?.receiver) continue;
    (byTarget.get(target) ?? byTarget.set(target, []).get(target)!).push(r);
  }
  if (byTarget.size === 0) return;

  interface Base { prefix: string; middleware: string[]; guards: GuardAttr[] }
  const memo = new Map<string, Base[]>();
  const onStack = new Set<string>();
  const effective = (recv: string): Base[] => {
    const cached = memo.get(recv);
    if (cached) return cached;
    const incoming = byTarget.get(recv);
    if (!incoming || onStack.has(recv)) return [{ prefix: "", middleware: [], guards: [] }];
    onStack.add(recv);
    const out: Base[] = [];
    for (const m of incoming) {
      const meta = routeMeta.get(m);
      for (const base of effective(meta?.receiver ?? "")) {
        out.push({
          prefix: joinPrefix(base.prefix, m.path),
          middleware: [...base.middleware, ...m.middleware],
          guards: [...base.guards, ...(meta?.guards ?? [])],
        });
      }
    }
    onStack.delete(recv);
    memo.set(recv, out);
    return out;
  };

  const composed = new Set([...byTarget.values()].flat());
  const next: RouteInfo[] = [];
  for (const r of routes) {
    if (composed.has(r)) {
      routeMeta.delete(r);
      continue;
    }
    const meta = routeMeta.get(r);
    if (!meta?.receiver || !byTarget.has(meta.receiver) || r.mount) {
      next.push(r);
      continue;
    }
    for (const base of effective(meta.receiver)) {
      const copy: RouteInfo = { ...r, path: joinPrefix(base.prefix, r.path), middleware: [...base.middleware, ...r.middleware] };
      routeMeta.set(copy, { ...meta, mountGuards: [...base.guards, ...(meta.mountGuards ?? [])] });
      next.push(copy);
    }
    routeMeta.delete(r);
  }
  routes.splice(0, routes.length, ...next);
}

/** `"/api"` + `"/users"` → `"/api/users"`; `"/api"` + `"/"` → `"/api"`. */
function joinPrefix(prefix: string, path: string): string {
  if (!prefix) return path;
  const head = prefix.replace(/\/+$/, "");
  if (path === "/" || path === "") return head || "/";
  if (path === "*") return `${head}/*`;
  return `${head}/${path.replace(/^\/+/, "")}`;
}
