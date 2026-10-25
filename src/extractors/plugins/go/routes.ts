import type { RouteFact, RouteInfo } from "../../../types/analysis.js";
import { buildAuth, type GuardAttr } from "../../shared/route-metadata.js";
import { ROUTER_CALL, type RouterCall } from "../shared/router-functions.js";

/**
 * Go server routes across the ecosystem's router families:
 *
 *   - net/http 1.22+:  mux.HandleFunc("GET /users/{id}", h) / mux.Handle(...)
 *   - net/http legacy: http.HandleFunc("/users", h)            (verb unknown)
 *   - gin / echo:      r.GET("/users", h), api := r.Group("/api"); api.GET(...)
 *   - chi:             r.Get("/users", h), r.Route("/api", func(r chi.Router) {...}),
 *                      r.Method("GET", "/users", h), r.With(mw).Get(...)
 *   - fiber:           app.Get("/users/:id", h), g := app.Group("/api")
 *   - gorilla/mux:     r.HandleFunc("/users", h).Methods("GET", "POST"),
 *                      s := r.PathPrefix("/api").Subrouter()
 *
 * Group/subrouter prefixes compose: variables bound via `Group(...)` /
 * `PathPrefix(...).Subrouter()` carry their (possibly chained) prefix, and chi
 * `Route("/p", func(r ...) { ... })` blocks stack a prefix for routes declared
 * inside the block (tracked by brace depth — this is the regex path, there is
 * no AST). Before this, Title-case verb routers (chi/fiber) and gorilla's
 * `.Methods(...)` form produced zero routes, and group prefixes were dropped,
 * so client `/api/v1/users` calls could not join gin's `users.GET("", h)`.
 *
 * Middleware travels the same way. `r.Use(a, b)` adds to every route later
 * registered on `r` (and to groups created from `r` afterwards — gin/echo/chi
 * copy the parent's chain at `Group` time, which is what line order models);
 * `r.Group("/admin", auth())` and chi `With(mw)` / block-scoped `Use` attach
 * to their group; extra arguments between the path and the handler
 * (`r.GET("/x", AuthRequired(), h)`) and wrappers around the handler
 * (`mux.Handle("/x", auth(h))`) are the route's own guards. Every guard text
 * lands in `middleware`; the ones whose name reads as an auth check
 * (`AuthRequired`, `jwtauth.Verifier`, `RequireRole("admin")`) also fill
 * `auth` — a scheme when the name says how (jwt/bearer/basic/oauth), roles
 * when a role middleware lists literals, a policy otherwise. Plain
 * middleware (`gin.Logger()`, `cors.New()`) stays in `middleware` only.
 *
 * A router can be handed to a function that registers on it
 * (`users.Register(v1.Group("/users"))` → `func Register(r *gin.RouterGroup)`).
 * Routes registered on such a parameter (or a group derived from it) are
 * owned by their function (`owner: "fn:Register"`) and keep only the path the
 * function knows; each call passing a router is a `router-call` fact with
 * the prefix and guards the router carries there. `goRouterFnResolver` joins
 * the two across files and packages.
 *
 * The handler is kept as the expression text (`handler.ListProducts`,
 * `h.GetUser`); the project-level join resolves it and reads the handler's
 * body for what it binds (`FunctionInfo.requestAccess`), so no params are
 * written here.
 */

const HTTP_VERBS_TITLE: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH",
  Delete: "DELETE", Options: "OPTIONS", Head: "HEAD",
};
const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

/** `mux.HandleFunc(` / `mux.Handle(` — Go 1.22 pattern strings or gorilla/legacy path-first. */
const HANDLE_RE = /(\w+|\))\.\s*Handle(?:Func)?\s*\(/;
/** `r.GET(` — gin/echo (ALL-CAPS verbs). */
const CAPS_VERB_RE = /(\w+|\))\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/;
/** `r.Get(` — chi/fiber (Title-case verbs). */
const TITLE_VERB_RE = /(\w+|\))\.\s*(Get|Post|Put|Patch|Delete|Options|Head)\s*\(/;
/** `r.Method("GET", "/path", h)` — chi. */
const CHI_METHOD_RE = /(\w+|\))\.\s*Method\s*\(/;
/** `r.With(mw...)` — chi inline middleware, chained before the verb. */
const CHI_WITH_RE = /(\w+)\.\s*With\s*\(/;
/** `.Methods("GET", "POST")` — gorilla verb constraint on the same line. */
const METHODS_RE = /\.\s*Methods\s*\(([^)]*)\)/;
/** `api := r.Group(` — gin/echo/fiber group binding (chains compose). */
const GROUP_RE = /(\w+)\s*:?=\s*(\w+)\.\s*Group\s*\(/;
/** `s := r.PathPrefix("/api").Subrouter()` — gorilla subrouter binding. */
const SUBROUTER_RE = /(\w+)\s*:?=\s*(\w+)\.\s*PathPrefix\s*\(\s*([^()]*?)\s*\)\s*\.\s*Subrouter\s*\(/;
/** `r.Route("/api", func(r chi.Router) {` / `r.Group(func(r chi.Router) {` — chi nested blocks. */
const CHI_BLOCK_RE = /(\w+)\.\s*(Route|Group)\s*\(/;
/** A parameter typed as a router: `router *gin.RouterGroup`, `e *echo.Echo`, `r chi.Router`, `app *fiber.App`. */
const ROUTER_PARAM_RE = /(\w+)\s+\*?(?:gin\.(?:RouterGroup|Engine|IRoutes|IRouter)|echo\.(?:Echo|Group)|chi\.(?:Router|Mux)|mux\.Router|fiber\.(?:App|Router)|http\.ServeMux|[a-z]\w*\.Router)\b/g;
/** A router built here: `r := gin.Default()`, `e := echo.New()`, `r := chi.NewRouter()`. */
const ENGINE_RE = /(\w+)\s*:?=\s*(?:gin\.(?:Default|New)|echo\.New|chi\.NewRouter|mux\.NewRouter|fiber\.New|http\.NewServeMux)\s*\(/;
/** Router methods that are registrations, not calls handing a router on. */
const ROUTER_METHODS = new Set(["Group", "Use", "Route", "Mount", "With", "Handle", "HandleFunc", "Method", "PathPrefix", "Subrouter", "Methods", "Static", "StaticFS", "NoRoute", "Any", "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "Get", "Post", "Put", "Patch", "Delete", "Options", "Head"]);

/** Handing a router to the standard library or a server start is serving it, not registering on it. */
const NOT_A_REGISTRAR = /^(?:http|log|fmt|os|signal|context|errors|strings|time|slog|httptest)\.|(?:^|\.)(?:ListenAndServe(?:TLS)?|Serve(?:TLS)?|Run(?:TLS)?|Start(?:TLS)?|Listen|Handler|ServeHTTP|Shutdown)$/;


/** `r.Use(a, b)` — router-level middleware. */
const USE_RE = /(\w+)\.\s*Use\s*\(/;

const STRING_RE = /^["'`]([^"'`]*)["'`]$/;
/** `conf.BaseUri("/livez")`, `cfg.BasePath("/s")`: the app's configured base in front of a literal path. */
const BASE_WRAPPED_RE = /^[A-Za-z_][\w.]*\.(?:Base\w*|\w*Prefix\w*)\s*\(\s*["'`](\/[^"'`]*)["'`]\s*\)$/;
/** `"/folders/" + root` — a literal path ending in `/`, then a variable. */
const PATH_PLUS_VAR_RE = /^["'`](\/[^"'`]*\/)["'`]\s*\+\s*([A-Za-z_]\w*)$/;
/** gin `r.Match(methods, "/p", h)` / `r.Any("/p", h)`. */
const MATCH_RE = /(\w+|\))\.\s*(Match|Any)\s*\(/;
/** `baseUrl+"/cart"`, `cfg.BasePath + "/x"`: a path under a base the deployment sets — the base is not part of the route. */
const BASE_PLUS_PATH_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\+\s*["'`](\/[^"'`]*)["'`]$/;
/** Names that read as an authentication/authorization check. */
const AUTH_NAME_RE = /auth|jwt|token|session|login|guard|protect|permission|role|admin|verify|require/i;
/** Names that say HOW a request is authenticated. */
const SCHEME_NAME_RE = /jwt|basic|bearer|oauth/i;
/** Wrappers that are transparent, not middleware. */
const TRANSPARENT_WRAPPERS = new Set(["http.HandlerFunc", "HandlerFunc", "http.Handler", "gin.WrapH", "gin.WrapF", "echo.WrapHandler", "adaptor.HTTPHandler"]);

function joinPrefix(prefix: string, path: string): string {
  // A suffix (`m.Get(".rss", …)` under `/{username}`) extends the group's last segment.
  if (/^\.\w/.test(path)) return joinPrefix(prefix, "") + path;
  const parts = (prefix + "/" + path).split("/").filter(Boolean);
  return "/" + parts.join("/");
}

/** A project's own router constructor: `m := web.NewRouter()`. */
const PROJECT_ROUTER_RE = /(\w+)\s*:?=\s*(?:\w+\.)?New(?:Router|Mux)\s*\(\s*\)/;
/** `r.Mount("/api/v1", apiv1.Routes())` — a router a function returns, mounted. */
const MOUNT_CALL_RE = /(\w+)\.\s*Mount\s*\(\s*["'`]([^"'`]*)["'`]\s*,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(\s*\)\s*\)/;
/** gitea's `m.Combo("/path", mw…).Get(h).Post(mw, h2)`: one path, a chain of verbs. */
const COMBO_RE = /(\w+)\.\s*Combo\s*\(/;
/** gitea's `m.Methods("GET, POST", "/path", h)`: the verbs first. */
const VERBS_FIRST_RE = /(\w+)\.\s*Methods\s*\(\s*["'`]/;
/** gorilla's route builder: `r.Methods("GET").Path("/x").HandlerFunc(h)`, `r.Path("/x").Methods("POST").Handler(h)`. */
const GORILLA_CHAIN_RE = /(\w+)\.\s*(?:Methods|Path)\s*\(/;
/** A string constant: `const apiBase = "/league"`, or `apiBase = "/league"` inside a `const (…)` block. */
const CONST_SINGLE_RE = /^\s*const\s+([A-Za-z_]\w*)(?:\s+string)?\s*=\s*"([^"\\]*)"\s*(?:\/\/.*)?$/;
const CONST_IN_BLOCK_RE = /^\s*([A-Za-z_]\w*)(?:\s+string)?\s*=\s*"([^"\\]*)"\s*(?:\/\/.*)?$/;
/** `apiBase + "/matches"`, `apiBase`: a path built on a string constant. */
const CONST_PLUS_PATH_RE = /^([A-Za-z_]\w*)(?:\s*\+\s*["'`]([^"'`]*)["'`])?$/;

/** The file's string constants by name; a name declared twice with different values is left out. */
function stringConstants(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const clash = new Set<string>();
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*const\s*\(\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock && /^\s*\)/.test(line)) { inBlock = false; continue; }
    const m = (inBlock ? CONST_IN_BLOCK_RE : CONST_SINGLE_RE).exec(line);
    if (!m) continue;
    if (out.has(m[1]!) && out.get(m[1]!) !== m[2]) clash.add(m[1]!);
    out.set(m[1]!, m[2]!);
  }
  for (const c of clash) out.delete(c);
  return out;
}

/** A verb in a chain: `.Get(`, `.Post(`, … `.Any(`. */
const CHAIN_VERB_RE = /\.\s*(Get|Post|Put|Patch|Delete|Options|Head|Any)\s*\(/g;

/** Net brace change on a line, ignoring braces inside string literals. */
function braceDelta(line: string): number {
  const stripped = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
  let d = 0;
  for (const ch of stripped) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

/**
 * Top-level arguments of the call whose `(` sits at `open`, split at depth-0
 * commas with quotes honoured. `closed` is false when the line ends inside
 * the call (an inline `func(c *gin.Context) {` closure spills onto the next
 * lines) — the args collected so far are still right.
 */
function parseArgs(line: string, open: number): { args: string[]; end: number; closed: boolean } {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (let i = open; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < line.length) { cur += line[++i]!; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1 && ch === "(") continue; // the call's own paren
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (cur.trim()) args.push(cur.trim());
        return { args, end: i + 1, closed: true };
      }
    } else if (ch === "," && depth === 1) {
      if (cur.trim()) args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return { args, end: line.length, closed: false };
}

/** A guard as declared, classified by what its name says. */
function classifyGuard(raw: string): GuardAttr {
  const text = raw.replace(/\s+/g, " ").trim();
  const callee = text.match(/^[\w.]+/)?.[0] ?? text;
  if (!AUTH_NAME_RE.test(callee)) return { text };
  if (/role/i.test(callee)) {
    const literals = [...text.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
    if (literals.length > 0) return { text, roles: literals };
  }
  if (SCHEME_NAME_RE.test(callee)) return { text, schemes: [callee] };
  return { text, policies: [callee] };
}

function isAuthGuard(g: GuardAttr): boolean {
  return (g.policies?.length ?? 0) + (g.roles?.length ?? 0) + (g.schemes?.length ?? 0) > 0;
}

/**
 * The handler an argument names, unwrapping middleware applied inline:
 * `auth(h)` → handler `h` guarded by `auth`; `http.HandlerFunc(h)` → `h`.
 * An inline closure (`func(c *gin.Context) {`) has no name.
 */
function unwrapHandler(arg: string): { handler: string | null; guards: GuardAttr[] } {
  const guards: GuardAttr[] = [];
  let cur = arg.trim();
  for (let i = 0; i < 4; i++) {
    if (/^[\w.]+$/.test(cur)) return { handler: cur, guards };
    const wrap = cur.match(/^([\w.]+)\s*\(([\s\S]*)\)$/);
    if (!wrap) break;
    const inner = parseArgs(`(${wrap[2]!})`, 0).args;
    if (!TRANSPARENT_WRAPPERS.has(wrap[1]!)) guards.push(classifyGuard(cur));
    const next = inner.find((a) => /^[\w.]+$/.test(a) || /^[\w.]+\s*\(/.test(a));
    if (!next) break;
    cur = next;
  }
  return { handler: null, guards };
}

export function extractGoRoutes(lines: string[], facts?: RouteFact[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  /** Router variables in scope; those rooted at the function's router parameter map to true. */
  const routerVars = new Map<string, boolean>();
  /** Router variable → composed path prefix (Group / PathPrefix chains). */
  const varPrefix = new Map<string, string>();
  /** Router variable → middleware chain accumulated so far (Use + Group args). */
  const varGuards = new Map<string, GuardAttr[]>();
  /** Open chi Route/Group blocks: prefix + block-scoped Use apply until depth drops below entry. */
  const routeStack: Array<{ depth: number; prefix: string; guards: GuardAttr[] }> = [];
  let depth = 0;

  const stackPrefix = (): string => routeStack.map((s) => s.prefix).join("");
  const prefixOf = (recv: string): string => stackPrefix() + (varPrefix.get(recv) ?? "");
  const inheritedOf = (recv: string): GuardAttr[] => [
    ...(varGuards.get(recv) ?? []),
    ...routeStack.flatMap((s) => s.guards),
  ];

  const push = (
    path: string,
    method: string | null,
    handler: string | null | undefined,
    line: number,
    inherited: GuardAttr[],
    own: GuardAttr[],
    recv?: string,
  ): void => {
    const route: RouteInfo = {
      path,
      httpMethod: method,
      kind: "api",
      handler: handler || null,
      calls: [],
      middleware: [...inherited, ...own].map((g) => g.text),
      line,
      // Registered on the function's router parameter: the path is relative to wherever it is passed.
      ...(recv && routerVars.get(recv) && currentFn ? { owner: `fn:${currentFn}` } : {}),
    };
    const auth = buildAuth(inherited.filter(isAuthGuard), own.filter(isAuthGuard));
    if (auth) route.auth = auth;
    routes.push(route);
  };

  /** Registration args after the path: middleware in the middle, the handler last. */
  const splitHandler = (rest: string[]): { handler: string | null; guards: GuardAttr[] } => {
    if (rest.length === 0) return { handler: null, guards: [] };
    // A string literal between path and handler is a client call's content
    // type, not middleware (`client.Post("/api", "application/json", body)`).
    const guards = rest.slice(0, -1).filter((a) => !STRING_RE.test(a)).map(classifyGuard);
    const lastArg = rest[rest.length - 1]!;
    const last = unwrapHandler(lastArg);
    // An inline closure (`router.GET("/albums/:uid", func(c *gin.Context) {`)
    // has no name of its own, but the function declaring the route does, and
    // its body — the closure included — is where the handling lives. Anchor
    // the route there so the trace continues into that body's calls.
    const handler = last.handler ?? (/^func\s*\(/.test(lastArg.trim()) && currentFn ? currentFn : null);
    return { handler, guards: [...guards, ...last.guards] };
  };
  /** The top-level function the current line is in (`func GetAlbum(router *gin.RouterGroup) {`). */
  let currentFn: string | null = null;
  /** The current function returns the router it builds. */
  let returnsRouter = false;

  const constants = stringConstants(lines);
  const literal = (arg: string | undefined): string | null => {
    // `apiBase + "/matches"` / `apiBase` on a constant the file declares: the constant is part of the path.
    const onConst = arg?.trim().match(CONST_PLUS_PATH_RE);
    const base = onConst ? constants.get(onConst[1]!) : undefined;
    if (base !== undefined && base.startsWith("/")) return onConst![2] === undefined ? base : joinPrefix(base, onConst![2]!);
    const m = arg?.match(STRING_RE) ?? arg?.match(BASE_PLUS_PATH_RE) ?? arg?.match(BASE_WRAPPED_RE);
    if (m) return m[1]!;
    // `"/folders/" + root`: the variable is a segment the caller fills.
    const tail = arg?.match(PATH_PLUS_VAR_RE);
    return tail ? `${tail[1]}{${tail[2]}}` : null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const fnDecl = line.match(/^func\s+(?:\((?:\w+\s+)?\*?(\w+)(?:\[[^\]]*\])?\)\s*)?(\w+)\s*[[(]/); // `[` — a generic func's type parameters
    if (fnDecl) {
      // A method is its receiver type's: `func (h *FileMigratorWeb) RegisterRoutes(g *echo.Group)` → FileMigratorWeb.RegisterRoutes.
      currentFn = fnDecl[1] ? `${fnDecl[1]}.${fnDecl[2]!}` : fnDecl[2]!;
      routerVars.clear();
      // `func Routes() *web.Router {`: the router it builds is mounted wherever a caller mounts the result.
      returnsRouter = /\)\s*\*?(?:\w+\.)?(?:Router|Mux|ServeMux|Engine|Echo|App|Handler)\s*\{\s*$/.test(line);
      const params = line.slice(fnDecl.index! + fnDecl[0].length - 1);
      for (const m of params.slice(0, params.indexOf(")") + 1 || undefined).matchAll(ROUTER_PARAM_RE)) {
        routerVars.set(m[1]!, true);
        varPrefix.delete(m[1]!);
        varGuards.delete(m[1]!);
      }
    }
    const engine = line.match(ENGINE_RE) ?? line.match(PROJECT_ROUTER_RE);
    if (engine) routerVars.set(engine[1]!, returnsRouter);

    // `r.Mount("/api/v1", apiv1.Routes())`: the routes the callee's returned router holds, served under the prefix.
    const mount = facts ? line.match(MOUNT_CALL_RE) : null;
    if (mount && routerVars.has(mount[1]!)) {
      const call: RouterCall = { callee: mount[3]!, prefix: joinPrefix(prefixOf(mount[1]!), mount[2]!), relative: routerVars.get(mount[1]!)!, guards: inheritedOf(mount[1]!) };
      facts!.push({ kind: ROUTER_CALL, line: lineNo, ...(currentFn ? { owner: currentFn } : {}), data: call });
    }

    const subMatch = line.match(SUBROUTER_RE);
    const subPrefix = subMatch ? literal(subMatch[3]) : null;
    const sub = subPrefix !== null ? subMatch : null;
    if (sub && routerVars.has(sub[2]!)) routerVars.set(sub[1]!, routerVars.get(sub[2]!)!);
    if (sub) {
      varPrefix.set(sub[1]!, (varPrefix.get(sub[2]!) ?? "") + subPrefix!);
      varGuards.set(sub[1]!, [...(varGuards.get(sub[2]!) ?? [])]);
    }
    const group = sub ? null : line.match(GROUP_RE);
    if (group) {
      const { args } = parseArgs(line, group.index! + group[0].length - 1);
      const prefix = literal(args[0]);
      if (prefix !== null) {
        if (routerVars.has(group[2]!)) routerVars.set(group[1]!, routerVars.get(group[2]!)!);
        varPrefix.set(group[1]!, (varPrefix.get(group[2]!) ?? "") + prefix);
        varGuards.set(group[1]!, [...(varGuards.get(group[2]!) ?? []), ...args.slice(1).map(classifyGuard)]);
      }
    }

    const use = line.match(USE_RE);
    if (use) {
      const { args } = parseArgs(line, use.index! + use[0].length - 1);
      const guards = args.map(classifyGuard);
      if (routeStack.length > 0) routeStack[routeStack.length - 1]!.guards.push(...guards);
      else varGuards.set(use[1]!, [...(varGuards.get(use[1]!) ?? []), ...guards]);
      depth += braceDelta(line);
      continue;
    }

    const chiBlock = group ? null : line.match(CHI_BLOCK_RE);
    if (chiBlock) {
      const { args, closed } = parseArgs(line, chiBlock.index! + chiBlock[0].length - 1);
      // chi's `Route("/p", func(r) {…})` and `Group(func(r) {…})`; gitea's `Group("/p", func() {…}, mw…)`.
      const prefixed = chiBlock[2] === "Route" || (literal(args[0]) !== null && /^func\s*\(/.test(args[1] ?? ""));
      const prefix = prefixed ? literal(args[0]) : "";
      const body = args[prefixed ? 1 : 0];
      if (prefix !== null && body && /^func\s*\(/.test(body) && !closed) {
        // The block body sits one brace deeper than the current depth.
        routeStack.push({ depth: depth + braceDelta(line), prefix, guards: [] });
        depth += braceDelta(line);
        continue;
      }
    }

    // gitea: `m.Combo("/forks").Get(repo.ListForks).Post(mw, repo.CreateFork)`, possibly over several lines.
    const combo = line.match(COMBO_RE);
    if (combo) {
      let text = line;
      for (let k = i + 1; k < Math.min(lines.length, i + 12) && (/\.\s*$/.test(text) || /^\s*\./.test(lines[k]!)); k++) text += " " + lines[k]!.trim();
      const { args, end } = parseArgs(text, combo.index! + combo[0].length - 1);
      const path = literal(args[0]);
      if (path !== null) {
        const recv = combo[1]!;
        const comboGuards = args.slice(1).filter((a) => !STRING_RE.test(a)).map(classifyGuard);
        CHAIN_VERB_RE.lastIndex = end;
        for (const v of text.matchAll(CHAIN_VERB_RE)) {
          if (v.index! < end) continue;
          const { args: vargs } = parseArgs(text, v.index! + v[0].length - 1);
          const { handler, guards } = splitHandler(vargs);
          const method = v[1] === "Any" ? null : HTTP_VERBS_TITLE[v[1]!]!;
          push(joinPrefix(prefixOf(recv), path), method, handler, lineNo, inheritedOf(recv), [...comboGuards, ...guards], recv);
        }
        depth += braceDelta(line);
        while (routeStack.length > 0 && depth < routeStack[routeStack.length - 1]!.depth) routeStack.pop();
        continue;
      }
    }
    // gorilla: `r.Methods("GET").Path("/matches/{id}").HandlerFunc(h)` — verbs, path and handler as chained calls.
    const chain = line.match(GORILLA_CHAIN_RE);
    if (chain && routerVars.has(chain[1]!)) {
      let text = line;
      for (let k = i + 1; k < Math.min(lines.length, i + 8) && (/\.\s*$/.test(text) || /^\s*\./.test(lines[k]!)); k++) text += " " + lines[k]!.trim();
      const pathCall = /\.\s*Path\s*\(/.exec(text);
      const handlerCall = /\.\s*Handler(?:Func)?\s*\(/.exec(text);
      const path = pathCall ? literal(parseArgs(text, pathCall.index + pathCall[0].length - 1).args[0]) : null;
      if (path !== null && path.startsWith("/") && handlerCall) {
        const recv = chain[1]!;
        const methodsArg = /\.\s*Methods\s*\(([^)]*)\)/.exec(text)?.[1] ?? "";
        const verbs = [...methodsArg.matchAll(/["'`](\w+)["'`]|\bhttp\.Method([A-Z][a-z]+)\b/g)].map((m) => (m[1] ?? m[2]!).toUpperCase()).filter((v) => VERBS.has(v));
        const { handler, guards } = splitHandler(parseArgs(text, handlerCall.index + handlerCall[0].length - 1).args);
        const full = joinPrefix(prefixOf(recv), path);
        if (verbs.length > 0) for (const v of verbs) push(full, v, handler, lineNo, inheritedOf(recv), guards, recv);
        else push(full, null, handler, lineNo, inheritedOf(recv), guards, recv);
        depth += braceDelta(line);
        while (routeStack.length > 0 && depth < routeStack[routeStack.length - 1]!.depth) routeStack.pop();
        continue;
      }
    }
    const verbsFirst = line.match(VERBS_FIRST_RE);
    if (verbsFirst) {
      const recv = verbsFirst[1]!;
      const { args } = parseArgs(line, verbsFirst.index! + verbsFirst[0].length - 2);
      const verbs = (literal(args[0]) ?? "").split(",").map((v) => v.trim().toUpperCase()).filter((v) => VERBS.has(v));
      const path = literal(args[1]);
      if (verbs.length > 0 && path !== null && args.length >= 3) {
        const { handler, guards } = splitHandler(args.slice(2));
        for (const v of verbs) push(joinPrefix(prefixOf(recv), path), v, handler, lineNo, inheritedOf(recv), guards, recv);
        depth += braceDelta(line);
        while (routeStack.length > 0 && depth < routeStack[routeStack.length - 1]!.depth) routeStack.pop();
        continue;
      }
    }

    // chi `r.With(mw).Get("/p", h)` — inline guards, then the verb call.
    let withGuards: GuardAttr[] = [];
    let withRecv: string | null = null;
    const withM = line.match(CHI_WITH_RE);
    if (withM) {
      const { args } = parseArgs(line, withM.index! + withM[0].length - 1);
      withGuards = args.map(classifyGuard);
      withRecv = withM[1]!;
    }
    // `r.With(mw).Get(` — the verb's receiver is a `)`, the router is `r`.
    const receiver = (captured: string): string => (captured === ")" ? withRecv ?? "" : captured);

    const caps = line.match(CAPS_VERB_RE);
    const title = caps ? null : line.match(TITLE_VERB_RE);
    const verb = caps ?? title;
    const match = verb ? null : line.match(MATCH_RE);
    if (match) {
      // gin `Match(methods, path, h…)` and `Any(path, h…)`: verbs as a literal list, else every one.
      const recv = receiver(match[1]!);
      const { args } = parseArgs(line, match.index! + match[0].length - 1);
      const any = match[2] === "Any";
      const path = literal(args[any ? 0 : 1]);
      if (path !== null && path.startsWith("/") && args.length >= (any ? 2 : 3)) {
        const { handler, guards } = splitHandler(args.slice(any ? 1 : 2));
        const verbs = any ? [] : [...(args[0] ?? "").matchAll(/["'`](\w+)["'`]|\bhttp\.Method([A-Z][a-z]+)\b/g)].map((m) => (m[1] ?? m[2]!).toUpperCase()).filter((v) => VERBS.has(v));
        if (verbs.length > 0) for (const v of verbs) push(joinPrefix(prefixOf(recv), path), v, handler, lineNo, inheritedOf(recv), [...withGuards, ...guards], recv);
        else push(joinPrefix(prefixOf(recv), path), null, handler, lineNo, inheritedOf(recv), [...withGuards, ...guards], recv);
      }
    } else if (verb) {
      const recv = receiver(verb[1]!);
      const method = caps ? caps[2]! : HTTP_VERBS_TITLE[title![2]!]!;
      const { args } = parseArgs(line, verb.index! + verb[0].length - 1);
      const path = literal(args[0]);
      // Title-case verbs must carry an absolute path — `s.Get("key")` is not a route — except inside
      // a router group's block, where `m.Get("", h)` is the group's own URL and `m.Get(".rss", h)` a suffix.
      const inBlock = routeStack.length > 0 && (path === "" || /^\.\w+$/.test(path ?? "") || /^[A-Za-z][\w-]*$/.test(path ?? ""));
      if (args.length >= 2 && path !== null && (caps || path.startsWith("/") || inBlock)) {
        const { handler, guards } = splitHandler(args.slice(1));
        push(joinPrefix(prefixOf(recv), path), method, handler, lineNo, inheritedOf(recv), [...withGuards, ...guards], recv);
      }
    } else {
      const chiMethod = line.match(CHI_METHOD_RE);
      const handle = chiMethod ? null : line.match(HANDLE_RE);
      if (chiMethod) {
        const recv = receiver(chiMethod[1]!);
        const { args } = parseArgs(line, chiMethod.index! + chiMethod[0].length - 1);
        const method = literal(args[0])?.toUpperCase();
        const path = literal(args[1]);
        if (args.length >= 3 && method && VERBS.has(method) && path !== null && path.startsWith("/")) {
          const { handler, guards } = splitHandler(args.slice(2));
          push(joinPrefix(prefixOf(recv), path), method, handler, lineNo, inheritedOf(recv), [...withGuards, ...guards], recv);
        }
      } else if (handle) {
        const recv = receiver(handle[1]!);
        const { args } = parseArgs(line, handle.index! + handle[0].length - 1);
        const first = args.length >= 2 ? literal(args[0]) : null;
        const go122 = first?.match(/^([A-Z]+)\s+(\S+)$/);
        // gin `Handle(method, path, h…)`: `"GET"`, `http.MethodGet`, `header.MethodPost`.
        const ginVerb = args.length >= 3 ? (/^["'`]([A-Z]+)["'`]$/.exec(args[0]!)?.[1] ?? /^\w+\.Method([A-Z][a-z]+)$/.exec(args[0]!)?.[1]?.toUpperCase()) : undefined;
        const ginPath = ginVerb && VERBS.has(ginVerb) ? literal(args[1]) : null;
        if (ginPath !== null && ginPath.startsWith("/")) {
          const { handler, guards } = splitHandler(args.slice(2));
          push(joinPrefix(prefixOf(recv), ginPath), ginVerb!, handler, lineNo, inheritedOf(recv), [...withGuards, ...guards], recv);
        } else if (go122 && VERBS.has(go122[1]!)) {
          // Go 1.22 "VERB /path" pattern strings (absolute — no group composition).
          const { handler, guards } = splitHandler(args.slice(1));
          push(go122[2]!, go122[1]!, handler, lineNo, inheritedOf(recv), [...withGuards, ...guards], recv);
        } else if (first !== null && first.startsWith("/")) {
          // gorilla / legacy net/http: path-first, verbs (if any) constrained
          // by a same-line `.Methods(...)`.
          const path = joinPrefix(prefixOf(recv), first);
          const { handler, guards } = splitHandler(args.slice(1));
          const methodsArg = line.match(METHODS_RE)?.[1] ?? "";
          // `"GET"` or net/http's `http.MethodGet`.
          const verbs = [...methodsArg.matchAll(/["'`](\w+)["'`]|\bhttp\.Method([A-Z][a-z]+)\b/g)].map((m) => (m[1] ?? m[2]!).toUpperCase());
          const own = [...withGuards, ...guards];
          if (verbs.length > 0) for (const v of verbs) push(path, v, handler, lineNo, inheritedOf(recv), own, recv);
          else push(path, null, handler, lineNo, inheritedOf(recv), own, recv);
        }
      }
      // A call handing a router on: `users.Register(v1.Group("/users"))`, `routes.Setup(r)`.
      if (facts && routerVars.size > 0 && !chiMethod && !handle) {
        for (const m of line.matchAll(/(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(/g)) {
          const callee = m[1]!;
          if (ROUTER_METHODS.has(callee.split(".").pop()!) || callee === "func" || NOT_A_REGISTRAR.test(callee)) continue;
          const { args } = parseArgs(line, m.index! + m[0].length - 1);
          for (const arg of args) {
            const bare = /^&?(\w+)$/.exec(arg)?.[1];
            const grouped = /^(\w+)\.\s*Group\s*\(\s*["'`]([^"'`]*)["'`]\s*(?:,([\s\S]*))?\)$/.exec(arg);
            const v = bare ?? grouped?.[1];
            if (!v || !routerVars.has(v)) continue;
            const extra = grouped ? parseArgs(`(${grouped[3] ?? ""})`, 0).args.map(classifyGuard) : [];
            const call: RouterCall = {
              callee,
              prefix: joinPrefix(prefixOf(v), grouped?.[2] ?? ""),
              relative: routerVars.get(v)!,
              guards: [...inheritedOf(v), ...extra],
            };
            facts.push({ kind: ROUTER_CALL, line: lineNo, ...(currentFn ? { owner: currentFn } : {}), data: call });
            break;
          }
        }
      }
    }

    depth += braceDelta(line);
    while (routeStack.length > 0 && depth < routeStack[routeStack.length - 1]!.depth) {
      routeStack.pop();
    }
  }

  return routes;
}
