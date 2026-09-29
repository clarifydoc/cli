import type { Node } from "web-tree-sitter";
import type { RouteInfo, CallInfo, RouteParamInfo } from "../../../../types/analysis.js";
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
            if (lastArgIsFn) {
              calls = collectCallNames(last!);
              params = inlineHandlerParams(path, last!, formFields);
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
              };
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
    const auth = buildAuth(inherited, meta.guards);
    if (auth) route.auth = auth;
    applyRouteMeta(route, { params: meta.params });
  }
}
