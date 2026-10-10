import type { RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import { buildAuth, inferredParam, pathParamNames, type GuardAttr } from "../../shared/route-metadata.js";
import { extractParamsFromDeclaration } from "../shared/regex-base.js";
import { parseRustParam } from "./params.js";
import { classifyRustParamType } from "./request-schema.js";

/**
 * Rust server routes — the three dominant frameworks, none of which produced
 * any routes before:
 *
 *   - actix-web:  #[get("/users/{id}")] above `async fn get_user(...)`,
 *                 plus #[route("/x", method = "GET")]
 *   - Rocket:     #[get("/users/<id>")] — same attribute shape as actix;
 *                 `<param>` segments are rewritten to `{param}` so the
 *                 cross-tier normalizer treats them as route params
 *   - axum:       Router::new().route("/users", get(list).post(create)) —
 *                 one route per method-router verb on the line
 *
 * axum `.nest("/api", user_routes())` composes when the nested router is
 * built by a SAME-FILE function: routes remember which `fn` they were declared
 * in, nest calls map that fn to a prefix (transitively — a nest inside a
 * nested fn chains), and prefixes are applied in a second pass. Cross-file
 * nesting stays out of scope.
 *
 * Parameters and guards:
 *   - An attribute-macro route has its handler right below, so its signature
 *     is read here: `Json<T>` / `web::Json<T>` → body T, `Form<T>` → form,
 *     `Query<T>` → query, `Path<T>` → route, `HeaderMap` → header,
 *     `State<..>` / `web::Data<..>` / `HttpRequest` → services; a plain param
 *     named in the path (`<id>` / `{id}`) is a route param and Rocket's
 *     `?<page>` / `data = "<user>"` name query and body params. A parameter
 *     whose type reads as a request guard (`AuthUser`, `Claims`, `ApiKey`) is
 *     the route's own guard (policy = the type) and binds as a service.
 *   - axum routes name a handler declared elsewhere; the project-level join
 *     resolves it and asks the plugin's `bindParam` — nothing is written here.
 *   - axum `.layer(..)` / `.route_layer(..)` cover the routes added BEFORE
 *     them on the same `Router` chain (that is axum's rule), including routes
 *     of a same-file nested/merged router; actix `App::new().wrap(..)` and
 *     `web::scope("/p").wrap(..)` cover every `.service(handler)` registered
 *     under them, which also gives those attribute routes the scope prefix.
 *     Guard texts land in `middleware`; the ones that read as an auth check
 *     (`from_fn(auth)`, `HttpAuthentication::bearer(v)`, `login_required!`)
 *     also fill `auth` — a scheme for bearer/basic/jwt, a policy otherwise.
 */

/** `#[get("/path")]` / `#[rocket::get("/path?<q>")]` — actix & Rocket verb macros. */
const ATTR_VERB_RE = /^\s*#\[\s*(?:\w+::)*(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"([^)]*)\)/;
/** `#[route("/path", method = "GET", method = "POST")]` — actix multi-method. */
const ATTR_ROUTE_RE = /^\s*#\[\s*(?:\w+::)*route\s*\(\s*"([^"]+)"([^)]*)\)/;
const METHOD_ATTR_RE = /method\s*=\s*"(\w+)"/g;
/** `.route("/path", get(handler).post(handler2))` — axum method routers. */
const AXUM_ROUTE_RE = /\.\s*route\s*\(\s*"([^"]*)"\s*,(.*)$/;
const AXUM_VERB_RE = /\b(get|post|put|patch|delete|head|options)\s*\(\s*([\w:]+)?/g;
/** `web::get().to(handler)` — actix's closure-free route form. */
/** `web::get().to(h)` — or `get().to(h)` with the verb fns imported (`use actix_web::web::{get, post}`). An empty route path (`.route("", …)`) is the scope's own path. */
const ACTIX_TO_RE = /\b(?:web::)?(get|post|put|patch|delete|head)\s*\(\s*\)\s*\.\s*to\s*\(\s*(?:\w+::)*(\w+)/g;

const FN_RE = /\bfn\s+(\w+)/;
/** Top-level fn declaration — marks route-ownership scope for nest resolution. */
const FN_DEF_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/;
/** `.nest("/api", user_routes())` / `.nest("/api", routes::users())`. */
const NEST_RE = /\.\s*nest\s*\(\s*"([^"]+)"\s*,\s*(?:\w+::)*(\w+)/;
/** `.merge(user_routes())` — a nest with no prefix. */
const MERGE_RE = /\.\s*merge\s*\(\s*(?:\w+::)*(\w+)\s*\(/;
/** `.layer(X)` / `.route_layer(X)` — axum tower layers. */
const LAYER_RE = /\.\s*(?:route_layer|layer)\s*\(/g;
/** `Router::new()` / `Router::<S>::new()` opens a chain statement. */
const ROUTER_NEW_RE = /\bRouter(?:::<[^>]*>)?::new\s*\(/;

/** Names that read as an authentication/authorization check. */
const AUTH_NAME_RE = /auth|jwt|token|session|login|guard|protect|permission|role|admin|verify|require|bearer|basic|identity/i;
const SCHEME_RE = /\b(bearer|basic|digest|jwt|oauth2?)\b/i;

/** Rocket `<id>` / `<id..>` path params → `{id}` (the normalizer's wildcard form). */
function normalizeParams(path: string): string {
  return path.replace(/<([^>]+?)(?:\.\.)?>/g, "{$1}");
}

/** The handler fn declared within a few lines below an attribute macro. */
function fnBelow(lines: string[], attrLine: number): { name: string; line: number } | null {
  for (let j = attrLine + 1; j < Math.min(attrLine + 7, lines.length); j++) {
    const l = lines[j]!;
    if (/^\s*#\[/.test(l) || /^\s*\/\//.test(l)) continue; // stacked attrs / comments
    const m = l.match(FN_RE);
    if (m) return { name: m[1]!, line: j };
    if (l.trim() && !/^\s*(pub|async)\b/.test(l)) break; // something else — give up
  }
  return null;
}

/** Balanced `(...)` starting at `open`; the text inside, and where it ends (or the line end). */
function balanced(line: string, open: number): { inner: string; end: number } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"') quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return { inner: line.slice(open + 1, i), end: i + 1 };
    }
  }
  return { inner: line.slice(open + 1), end: line.length };
}

/** A guard as declared, classified by what its text says. */
function classifyGuard(raw: string): GuardAttr {
  const text = raw.replace(/\s+/g, " ").trim();
  const g: GuardAttr = { text };
  // `HttpAuthentication::bearer(validator)` / `RequireAuthorizationLayer::bearer("t")` / `ValidateRequestHeaderLayer::basic(u, p)`
  const scheme = text.match(/::(bearer|basic|digest|jwt|oauth2?)\s*\(([^)]*)\)/i);
  if (scheme) {
    g.schemes = [scheme[1]!.toLowerCase()];
    const validator = scheme[2]!.trim().match(/^(?:\w+::)*([a-z_]\w*)$/);
    if (validator) g.policies = [validator[1]!];
    return g;
  }
  // `middleware::from_fn(auth)` / `from_fn_with_state(state, require_admin)` → the fn is the check.
  const fromFn = text.match(/\bfrom_fn(?:_with_state)?\s*\(([^)]*)\)/);
  if (fromFn) {
    const args = fromFn[1]!.split(",").map((a) => a.trim()).filter(Boolean);
    const fn = (args[args.length - 1] ?? "").replace(/^(?:\w+::)*/, "");
    if (fn && AUTH_NAME_RE.test(fn)) g.policies = [fn];
    return g;
  }
  // `login_required!(Backend)` / `permission_required!(Backend, "admin")` — axum-login macros.
  const macro = text.match(/(?:\w+::)*(\w+)!\s*\(([^)]*)\)/);
  if (macro && AUTH_NAME_RE.test(macro[1]!)) {
    const literals = [...macro[2]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    g.policies = [macro[1]!, ...literals];
    return g;
  }
  // A layer/middleware value by its type or fn name: `RequireAuth`, `auth`, `Logger::default()`.
  const callee = text.match(/^(?:\w+::)*(\w+)/)?.[1] ?? text;
  if (AUTH_NAME_RE.test(callee)) {
    if (SCHEME_RE.test(callee)) g.schemes = [callee];
    else g.policies = [callee];
  }
  return g;
}

function isAuthGuard(g: GuardAttr): boolean {
  return (g.policies?.length ?? 0) + (g.roles?.length ?? 0) + (g.schemes?.length ?? 0) > 0;
}

/**
 * Parameters of an attribute-macro handler, bound by extractor type, Rocket
 * `data = "<x>"` / `?<q>` names and path tokens. Returns the params and the
 * request-guard params (a type reading as `AuthUser`/`Claims`/`ApiKey`).
 */
function attributeParams(
  lines: string[],
  fn: { name: string; line: number },
  path: string,
  attrRest: string,
): { params: RouteParamInfo[]; guards: GuardAttr[] } {
  const raw = extractParamsFromDeclaration(lines, fn.line, fn.name, parseRustParam);
  const dataName = attrRest.match(/\bdata\s*=\s*"<(\w+)>"/)?.[1] ?? null;
  const queryNames = new Set<string>();
  const q = path.indexOf("?");
  if (q >= 0) for (const m of path.slice(q + 1).matchAll(/<(\w+)(?:\.\.)?>/g)) queryNames.add(m[1]!);
  const tokens = pathParamNames(q >= 0 ? path.slice(0, q) : path);

  const params: RouteParamInfo[] = [];
  const guards: GuardAttr[] = [];
  for (const p of raw) {
    if (!p.type) { params.push({ name: p.name, type: null, binding: null }); continue; }
    const c = classifyRustParamType(p.type);
    // An extractor wrapper is explicit; Rocket's `data = "<x>"` / `?<q>` / `<id>`
    // names are explicit too and come before the guard-by-type-name reading,
    // so `#[post("/users", data = "<user>")] fn create(user: User)` is a body.
    if (c.binding && c.binding !== "services") { params.push({ name: p.name, type: c.inner, binding: c.binding }); continue; }
    if (dataName === p.name) { params.push({ name: p.name, type: p.type, binding: "body" }); continue; }
    if (queryNames.has(p.name)) { params.push({ name: p.name, type: p.type, binding: "query" }); continue; }
    if (tokens.has(p.name.toLowerCase())) { params.push(inferredParam(p.name, p.type, path, null)); continue; }
    if (c.guard) {
      guards.push({ text: c.guard, policies: [c.guard] });
      params.push({ name: p.name, type: p.type, binding: "services", inferred: true });
      continue;
    }
    if (c.binding === "services") { params.push({ name: p.name, type: p.type, binding: "services", inferred: true }); continue; }
    params.push({ name: p.name, type: p.type, binding: null });
  }
  return { params, guards };
}

export function extractRustRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  /** Owning fn per emitted route (parallel to `routes`; "" = top level). */
  const routeOwner: string[] = [];
  /** Guards applied directly to a route by a later `.layer` on its chain (parallel to `routes`). */
  const routeLayers: GuardAttr[][] = [];
  /** Own guards (Rocket-style guard params) per route. */
  const routeOwn: GuardAttr[][] = [];
  /** fn name → { prefix, owner } from the FIRST `.nest("/p", fn())` / `.merge(fn())` naming it. */
  const nests = new Map<string, { prefix: string; owner: string }>();
  /** Guards a nested fn's routes inherit from layers on the chain that nested it. */
  const fnLayers = new Map<string, GuardAttr[]>();
  /** Attribute-route handler fn → the actix scope that `.service()`s it. */
  const services = new Map<string, { prefix: string; guards: GuardAttr[] }>();
  let currentFn = "";

  // The axum chain statement in progress: routes and nested fns added so far.
  let chain: { routes: number[]; nested: string[] } | null = null;
  // actix App / scope nesting, tracked by paren depth across lines.
  const scopes: Array<{ prefix: string; guards: GuardAttr[]; depth: number }> = [];
  let parenDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const trimmed = line.trim();

    const fnDef = line.match(FN_DEF_RE);
    if (fnDef) { currentFn = fnDef[1]!; chain = null; }

    const verbAttr = line.match(ATTR_VERB_RE);
    if (verbAttr) {
      const fn = fnBelow(lines, i);
      const rawPath = verbAttr[2]!;
      const q = rawPath.indexOf("?");
      const route: RouteInfo = {
        path: normalizeParams(q >= 0 ? rawPath.slice(0, q) : rawPath),
        httpMethod: verbAttr[1]!.toUpperCase(),
        kind: "api",
        handler: fn?.name ?? null,
        calls: [],
        middleware: [],
        line: lineNo,
      };
      let own: GuardAttr[] = [];
      if (fn) {
        const { params, guards } = attributeParams(lines, fn, rawPath, verbAttr[3] ?? "");
        if (params.length > 0) route.params = params;
        own = guards;
      }
      routes.push(route);
      routeOwner.push(currentFn);
      routeLayers.push([]);
      routeOwn.push(own);
      continue;
    }

    const routeAttr = line.match(ATTR_ROUTE_RE);
    if (routeAttr) {
      const methods = [...routeAttr[2]!.matchAll(METHOD_ATTR_RE)].map((m) => m[1]!.toUpperCase());
      const fn = fnBelow(lines, i);
      const bound = fn ? attributeParams(lines, fn, routeAttr[1]!, routeAttr[2]!) : null;
      for (const m of methods.length > 0 ? methods : [null]) {
        const route: RouteInfo = {
          path: normalizeParams(routeAttr[1]!),
          httpMethod: m,
          kind: "api",
          handler: fn?.name ?? null,
          calls: [],
          middleware: [],
          line: lineNo,
        };
        if (bound && bound.params.length > 0) route.params = [...bound.params];
        routes.push(route);
        routeOwner.push(currentFn);
        routeLayers.push([]);
        routeOwn.push(bound?.guards ?? []);
      }
      continue;
    }

    // ── axum chain ────────────────────────────────────────────────────────
    if (ROUTER_NEW_RE.test(line)) chain = { routes: [], nested: [] };

    const nest = line.match(NEST_RE);
    const merge = nest ? null : line.match(MERGE_RE);
    const nestedFn = nest ? nest[2]! : merge ? merge[1]! : null;
    if (nestedFn) {
      if (!nests.has(nestedFn)) nests.set(nestedFn, { prefix: nest ? nest[1]! : "", owner: currentFn });
      if (!chain) chain = { routes: [], nested: [] };
      chain.nested.push(nestedFn);
    }

    const axum = line.match(AXUM_ROUTE_RE);
    if (axum) {
      if (!chain) chain = { routes: [], nested: [] };
      const scope = scopes[scopes.length - 1];
      const inherited = scope ? scopes.flatMap((s) => s.guards) : [];
      const prefix = scopes.map((s) => s.prefix).join("");
      const emit = (verb: string, handler: string | null): void => {
        routes.push({
          path: prefix ? joinPath(prefix, axum[1]!) : axum[1]!,
          httpMethod: verb.toUpperCase(),
          kind: "api",
          handler,
          calls: [],
          middleware: [],
          line: lineNo,
        });
        routeOwner.push(currentFn);
        routeLayers.push([...inherited]);
        routeOwn.push([]);
        chain!.routes.push(routes.length - 1);
      };
      ACTIX_TO_RE.lastIndex = 0;
      let to: RegExpExecArray | null;
      let actixHit = false;
      while ((to = ACTIX_TO_RE.exec(axum[2]!)) !== null) { actixHit = true; emit(to[1]!, to[2]!); }
      if (!actixHit) {
        AXUM_VERB_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = AXUM_VERB_RE.exec(axum[2]!)) !== null) {
          emit(m[1]!, m[2] ? m[2].replace(/^:+/, "").split("::").pop()! : null);
        }
      }
    }

    LAYER_RE.lastIndex = 0;
    let layer: RegExpExecArray | null;
    while ((layer = LAYER_RE.exec(line)) !== null) {
      const { inner, end } = balanced(line, layer.index + layer[0].length - 1);
      LAYER_RE.lastIndex = Math.max(LAYER_RE.lastIndex, end);
      const guard = classifyGuard(inner);
      if (!chain) continue;
      for (const idx of chain.routes) routeLayers[idx]!.push(guard);
      for (const fn of chain.nested) fnLayers.set(fn, [...(fnLayers.get(fn) ?? []), guard]);
    }

    // ── actix App / scope chain ───────────────────────────────────────────
    scanActix(line, scopes, services, () => parenDepth, (d) => { parenDepth = d; });

    if (chain && (trimmed.endsWith(";") || trimmed.startsWith("}"))) chain = null;
  }

  // Apply nest prefixes: a route declared in fn F gets F's (transitive) nest
  // prefix — `.nest("/api", user_routes())` inside a fn that is itself nested
  // chains outward. Cycle-guarded; unnested fns resolve to "".
  const resolvePrefix = (fn: string, seen: Set<string>): string => {
    const n = nests.get(fn);
    if (!n || seen.has(fn)) return "";
    seen.add(fn);
    return resolvePrefix(n.owner, seen) + n.prefix;
  };
  // Layers flow the same way: the chain that nested F covers F's routes.
  const resolveLayers = (fn: string, seen: Set<string>): GuardAttr[] => {
    const n = nests.get(fn);
    if (!n || seen.has(fn)) return [];
    seen.add(fn);
    return [...resolveLayers(n.owner, seen), ...(fnLayers.get(fn) ?? [])];
  };

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]!;
    const prefix = resolvePrefix(routeOwner[i]!, new Set());
    if (prefix) route.path = joinPath(prefix, route.path);

    let inherited = [...resolveLayers(routeOwner[i]!, new Set()), ...routeLayers[i]!];
    // An attribute route `.service()`d under an actix scope takes its prefix and guards.
    const svc = route.handler ? services.get(route.handler) : undefined;
    if (svc) {
      if (svc.prefix) route.path = joinPath(svc.prefix, route.path);
      inherited = [...svc.guards, ...inherited];
    }
    const own = routeOwn[i]!;
    if (inherited.length > 0 || own.length > 0) {
      route.middleware = [...inherited, ...own].map((g) => g.text);
      const auth = buildAuth(inherited.filter(isAuthGuard), own.filter(isAuthGuard));
      if (auth) route.auth = auth;
    }
  }

  return routes;
}

function joinPath(prefix: string, path: string): string {
  const joined = (prefix + "/" + path).replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return joined || "/";
}

/**
 * actix wiring on one line, in source order: `App::new()` opens the app scope,
 * `web::scope("/p")` opens a nested one that closes when the paren depth
 * drops below where it opened, `.wrap(X)` adds a guard to the innermost open
 * scope, `.service(handler)` binds that handler to the innermost scope.
 */
function scanActix(
  line: string,
  scopes: Array<{ prefix: string; guards: GuardAttr[]; depth: number }>,
  services: Map<string, { prefix: string; guards: GuardAttr[] }>,
  getDepth: () => number,
  setDepth: (d: number) => void,
): void {
  let depth = getDepth();
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"') { quote = ch; continue; }
    if (ch === "/" && line[i + 1] === "/") break;
    const rest = line.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^App::new\s*\(\s*\)/))) {
      scopes.length = 0;
      scopes.push({ prefix: "", guards: [], depth });
      i += m[0].length - 1;
      continue;
    }
    if ((m = rest.match(/^(?:\w+::)*scope\s*\(\s*"([^"]*)"\s*\)/))) {
      // Each frame holds its OWN segment; every reader joins the stack. A
      // frame that pre-composed its parents doubled them at the join
      // (`scope("/api/v4") … scope("/site")` → `/api/v4/api/v4/site`).
      scopes.push({ prefix: m[1]!, guards: [], depth });
      i += m[0].length - 1;
      continue;
    }
    if ((m = rest.match(/^\.\s*wrap(?:_fn)?\s*\(/))) {
      const { inner, end } = balanced(line, i + m[0].length - 1);
      const top = scopes[scopes.length - 1];
      if (top) top.guards.push(classifyGuard(inner));
      i = end - 1;
      continue;
    }
    if ((m = rest.match(/^\.\s*service\s*\(\s*(?:\w+::)*([a-z_]\w*)\s*\)/))) {
      const top = scopes[scopes.length - 1];
      if (top) services.set(m[1]!, { prefix: scopes.map((s) => s.prefix).join(""), guards: scopes.flatMap((s) => s.guards) });
      i += m[0].length - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      while (scopes.length > 1 && depth < scopes[scopes.length - 1]!.depth) scopes.pop();
      if (scopes.length === 1 && depth < scopes[0]!.depth) scopes.length = 0;
    }
  }
  setDepth(depth);
}
