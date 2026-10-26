import { azureFunctionPath } from "../shared/azure-functions.js";
import type { Node } from "web-tree-sitter";
import type { CallInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";
import { pythonStringTemplate } from "./module-values.js";
import { applyRouteMeta, boundParam, inferredParam, type GuardAttr } from "../../shared/route-metadata.js";
import { HTTP_METHODS } from "../../routes/base.js";
import type { RouteExtractor } from "../../routes/base.js";
import { scanRequestAccess } from "./request-access.js";
import { splitGeneric, unwrapNullable } from "./request-schema.js";
import { DJANGO_GATE, collectDjangoFacts } from "./django/facts.js";
import { PY_GRAPHQL_GATE, extractPythonGraphqlRoutes } from "./graphql.js";

/**
 * Python: `@app.get("/path")` (FastAPI, Flask ≥2), `@bp.route("/path", methods=[…])`
 * (Flask), plus the attribute layer each declares — router-level and
 * per-route `dependencies=[Depends(…)]`, Flask/Django guard decorators, and
 * the parameter bindings FastAPI reads off the handler signature.
 */
export function extractPythonRoutes(root: Node, routes: RouteInfo[]): void {
  const consts = collectModuleStrings(root);
  const routers = collectRouterDecls(root, consts);
  walkForPythonRoutes(root, routes, routers);
  walkForRouterMounts(root, routes, routers, consts);
}

/** Module-level `NAME = "literal"` — what a `prefix=prefix` keyword names. */
function collectModuleStrings(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of root.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const assignment = stmt.namedChild(0);
    if (assignment?.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (left?.type === "identifier" && right?.type === "string") out.set(left.text, stripQuotes(right.text));
  }
  return out;
}

/** A keyword argument's string value: a literal, or a module constant it names. Undefined when absent, null when unknowable. */
function stringKeyword(args: Node, name: string, consts: ReadonlyMap<string, string>): string | null | undefined {
  const value = keywordArg(args, name);
  if (!value) return undefined;
  if (value.type === "string") return stringValue(value.text, consts);
  if (value.type === "identifier" && consts.has(value.text)) return consts.get(value.text)!;
  return null;
}

/**
 * A string literal's value: `"/clubs"`, `r"/clubs"`, and an f-string over module
 * constants (`f"{base_prefix}/kits"`); null when an interpolation is not one.
 */
function stringValue(text: string, consts: ReadonlyMap<string, string>): string | null {
  const prefix = /^[rRbBuUfF]{0,2}/.exec(text)![0];
  const body = stripQuotes(text.slice(prefix.length));
  if (!/f/i.test(prefix)) return body;
  let unknown = false;
  const out = body.replace(/\{([^{}]*)\}/g, (_, name: string) => {
    const v = consts.get(name.trim());
    if (v === undefined) unknown = true;
    return v ?? "";
  });
  return unknown ? null : out;
}

/**
 * Router mounts: FastAPI `router.include_router(auth.router, prefix="/users")`,
 * Flask `app.register_blueprint(bp, url_prefix="/admin")`.
 *
 * The prefix lives here, in the wiring file, while the endpoints it applies to
 * are decorated in the module being mounted — so on its own that module's
 * routes look prefix-less and several routers' `@router.get("")` all collapse
 * to the same empty path. Emitted as `mount: true` rows (`handler` = the module
 * identifier to resolve through the import index), which `resolveRouterMounts`
 * composes across files.
 *
 * The mount's path is the RECEIVING router's own prefix joined with the include
 * prefix: `router = APIRouter(prefix="/api")` then `router.include_router(app.router)`
 * mounts `app` at `/api`, prefix or not — mealie lost `/api` on every route
 * when only a literal `prefix=` produced a mount. An empty mount still
 * composes (`api.py` → `recipe/__init__.py` → `recipe_crud_routes.py`). A
 * prefix this file cannot know (`prefix=settings.api_prefix`) mounts at what
 * is known and says so (`prefixUnresolved`). The receiving router's
 * `dependencies` guard everything mounted under it.
 */
function walkForRouterMounts(
  node: Node,
  routes: RouteInfo[],
  routers: ReadonlyMap<string, RouterDecl>,
  consts: ReadonlyMap<string, string>,
): void {
  if (node.type === "call") {
    const fn = node.childForFieldName("function");
    const leaf = fn?.type === "attribute" ? fn.childForFieldName("attribute")?.text : null;
    if (leaf === "include_router" || leaf === "register_blueprint") {
      const args = node.childForFieldName("arguments");
      const router = args ? firstPositionalArg(args) : null;
      // `auth.router` → "auth", the name the import index can resolve.
      const handler = router ? rootIdentifier(router) : null;
      const receiverNode = fn!.childForFieldName("object");
      const receiver = receiverNode?.type === "identifier" ? routers.get(receiverNode.text) : undefined;
      const prefix = args ? stringKeyword(args, leaf === "include_router" ? "prefix" : "url_prefix", consts) : undefined;
      if (handler) {
        const mount: RouteInfo = {
          path: joinPrefix(receiver?.prefix ?? "", prefix ?? ""),
          httpMethod: null,
          kind: "api",
          handler,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
          mount: true,
        };
        if (prefix === null) mount.prefixUnresolved = `mount:${collapse(keywordArg(args!, leaf === "include_router" ? "prefix" : "url_prefix")!.text)}`;
        if (receiver?.guards.length) applyRouteMeta(mount, { guards: receiver.guards });
        routes.push(mount);
      }
    }
  }
  for (const child of node.children) walkForRouterMounts(child, routes, routers, consts);
}

/** First non-keyword argument inside an `argument_list`. */
function firstPositionalArg(args: Node): Node | null {
  for (const child of args.namedChildren) {
    if (child.type !== "keyword_argument" && child.type !== "comment") return child;
  }
  return null;
}

/** The `value` node of `name=…` in an argument list, or null. */
function keywordArg(args: Node, name: string): Node | null {
  for (const child of args.namedChildren) {
    if (child.type !== "keyword_argument") continue;
    if (child.childForFieldName("name")?.text !== name) continue;
    return child.childForFieldName("value");
  }
  return null;
}

/** Value of `name="literal"` in an argument list, or null if absent/non-literal. */
function literalKeywordArg(args: Node, name: string): string | null {
  const value = keywordArg(args, name);
  return value?.type === "string" ? stripQuotes(value.text) : null;
}

/** Root identifier of an attribute chain: `auth.router` → "auth"; `x` → "x". */
function rootIdentifier(node: Node): string | null {
  let current: Node | null = node;
  while (current && current.type === "attribute") current = current.childForFieldName("object");
  return current?.type === "identifier" ? current.text : null;
}

/** Leaf name of a decorator's callee: `@auth.login_required` → login_required, `@jwt_required()` → jwt_required. */
function decoratorName(dec: Node): string | null {
  let target = dec.namedChild(0);
  if (target?.type === "call") target = target.childForFieldName("function");
  if (target?.type === "attribute") return target.childForFieldName("attribute")?.text ?? null;
  return target?.type === "identifier" ? target.text : null;
}

/**
 * String literals in an argument list or a list/tuple value, one level deep:
 * `roles_required("admin", "editor")` → both; `methods=["GET", "POST"]` → both.
 */
function stringArgs(node: Node | null): string[] {
  const out: string[] = [];
  if (!node) return out;
  if (node.type === "string") return [stripQuotes(node.text)];
  for (const child of node.namedChildren) {
    if (child.type === "string") out.push(stripQuotes(child.text));
    else if (child.type === "list" || child.type === "tuple") {
      for (const item of child.namedChildren) if (item.type === "string") out.push(stripQuotes(item.text));
    }
  }
  return out;
}

/** Identifiers in a list/tuple argument: `permission_classes([IsAuthenticated, IsAdmin])`. */
function identifierArgs(args: Node | null): string[] {
  const out: string[] = [];
  for (const child of args?.namedChildren ?? []) {
    const items = child.type === "list" || child.type === "tuple" ? child.namedChildren : [child];
    for (const item of items) if (item.type === "identifier" || item.type === "attribute") out.push(item.text);
  }
  return out;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

// ─── Router declarations: `router = APIRouter(prefix=…, dependencies=[…])` ──

interface RouterDecl {
  /** `APIRouter(prefix="/items")` / `Blueprint(…, url_prefix="/items")`. */
  prefix: string;
  /** `APIRouter(dependencies=[Depends(x)])` — every route on the router inherits them. */
  guards: GuardAttr[];
  /** The prefix `url_for` names its routes under: a Flask `Blueprint("clubs", …)`'s name, "" for an app. */
  endpointPrefix: string;
  /** An Azure Functions app or blueprint (`func.FunctionApp()`, `func.Blueprint()`): routes by `route=`, named by the function. */
  azure?: true;
}

const ROUTER_CTORS = new Set(["APIRouter", "Blueprint", "FastAPI", "Flask", "FunctionApp", "DFApp"]);
/** Azure Functions' app and blueprint constructors, as the `azure.functions` module is usually imported. */
const AZURE_APP_CTOR = /^(?:(?:func|azure\.functions|df|durable_functions)\.)?(?:FunctionApp|DFApp)$|^(?:func|azure\.functions|df|durable_functions)\.Blueprint$/;
/** A project's own router class (`UserAPIRouter(APIRouter)`, `AdminRouter`) takes a prefix the same way. */
const ROUTER_CLASS_NAME = /Router$/;

/**
 * Module-level `name = APIRouter(...)` / `Blueprint(...)` assignments, keyed by
 * the variable a decorator will name as its receiver. Same file only: a router
 * imported from elsewhere carries its prefix through `include_router`, not here.
 */
function collectRouterDecls(root: Node, consts: ReadonlyMap<string, string>): Map<string, RouterDecl> {
  const decls = new Map<string, RouterDecl>();
  for (const stmt of root.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const assignment = stmt.namedChild(0);
    if (assignment?.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (left?.type !== "identifier" || right?.type !== "call") continue;
    const ctor = right.childForFieldName("function");
    const ctorName = ctor?.type === "attribute" ? ctor.childForFieldName("attribute")?.text : ctor?.text;
    if (!ctorName || (!ROUTER_CTORS.has(ctorName) && !ROUTER_CLASS_NAME.test(ctorName))) continue;
    const args = right.childForFieldName("arguments");
    const prefix = args ? (stringKeyword(args, "prefix", consts) ?? stringKeyword(args, "url_prefix", consts) ?? "") : "";
    const deps = args ? keywordArg(args, "dependencies") : null;
    // `Blueprint("clubs", __name__)`: its routes are `clubs.<function>` to `url_for`.
    const first = ctorName === "Blueprint" && args ? args.namedChildren.find((a) => a.type !== "keyword_argument" && a.type !== "comment") : undefined;
    const blueprint = first?.type === "string" ? first.text.replace(/^[a-z]*["']|["']$/gi, "") : null;
    decls.set(left.text, {
      prefix,
      guards: deps ? guardsFromDependencies(deps) : [],
      endpointPrefix: blueprint ? `${blueprint}.` : "",
      ...(AZURE_APP_CTOR.test(ctor!.text) ? { azure: true as const } : {}),
    });
  }
  return decls;
}

/** `[Depends(verify_token), Security(scopes_ok, scopes=["items:read"])]` → one guard each. */
function guardsFromDependencies(list: Node): GuardAttr[] {
  const guards: GuardAttr[] = [];
  const items = list.type === "list" || list.type === "tuple" ? list.namedChildren : [list];
  for (const item of items) {
    const guard = item.type === "call" ? dependencyGuard(item) : null;
    if (guard) guards.push(guard);
  }
  return guards;
}

/** Names of the dependency callables that are authentication/authorization checks, not data providers. */
const AUTH_DEPENDENCY = /auth|user|token|security|scope|permission|login|verify|require/i;

/**
 * `Depends(x)` → policy `x`; `Security(x, scopes=[…])` → policy `x` with the
 * scopes as roles. Returns null for anything else (`Query(...)`, a plain call).
 */
function dependencyGuard(call: Node): GuardAttr | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "identifier" || (fn.text !== "Depends" && fn.text !== "Security")) return null;
  const args = call.childForFieldName("arguments");
  const target = args ? firstPositionalArg(args) : null;
  const dependency = target ? target.text : null;
  if (!dependency) return null;
  const scopes = args ? stringArgs(keywordArg(args, "scopes")) : [];
  return {
    text: collapse(call.text),
    policies: [dependency],
    roles: scopes,
    schemes: [],
  };
}

// ─── Guard decorators: Flask-Login, Flask-JWT-Extended, Flask-Security, DRF ──

/**
 * A decorator that guards the view. Flask has no single convention, but the
 * extensions converge on `*_required` (`login_required`, `jwt_required()`,
 * `roles_required("admin")`, `permission_required("edit")`, `admin_required`)
 * and Django REST on `permission_classes([...])` / `authentication_classes([...])`.
 * Role decorators fill `roles`, class lists and permission strings `policies`,
 * JWT/authentication classes `schemes`; a bare `*_required` is a policy named
 * after itself.
 */
function guardFromDecorator(dec: Node): GuardAttr | null {
  const name = decoratorName(dec);
  if (!name) return null;
  const callee = dec.namedChild(0);
  const args = callee?.type === "call" ? callee.childForFieldName("arguments") : null;
  const text = collapse(dec.text.replace(/^@/, ""));
  const guard = (fields: Partial<GuardAttr>): GuardAttr => ({ text, policies: [], roles: [], schemes: [], ...fields });

  if (/^jwt_(?:refresh_token_)?required$|^verify_jwt_in_request$/.test(name)) return guard({ schemes: ["jwt"] });
  if (name === "authentication_classes") return guard({ schemes: identifierArgs(args) });
  if (name === "permission_classes") return guard({ policies: identifierArgs(args) });
  if (/^roles?_(?:required|accepted)$|^requires?_roles?$/.test(name)) return guard({ roles: stringArgs(args) });
  if (/^permissions?_required$|^requires?_permissions?$/.test(name)) {
    const perms = stringArgs(args);
    return guard({ policies: perms.length > 0 ? perms : [name] });
  }
  if (/_required$|^requires?_/.test(name)) return guard({ policies: [name] });
  return null;
}

// ─── Routes ───────────────────────────────────────────────────────────────

interface RouteDecorator {
  receiver: string | null;
  methods: string[];
  path: string;
  /** The path when it names module values (`CLUBS_URL + "/<id>"`), as a `${…}` template. */
  pathTemplate: string | null;
  /** `dependencies=[…]` on the decorator. */
  guards: GuardAttr[];
  /** `response_model=User`, `status_code=201` / `status.HTTP_201_CREATED`. */
  responseModel: string | null;
  statusCode: number | null;
  /** Flask `endpoint="x"`: the name `url_for` builds the URL from, instead of the function's. */
  endpoint: string | null;
  /** Azure Functions: `route="x"`, whether `methods=` was given, and `auth_level=`. */
  azureRoute: string | null;
  methodsListed: boolean;
  authLevel: string | null;
}

/**
 * `@x.get("/p")` (FastAPI/Flask verb shorthands), `@x.route("/p", methods=[…])`
 * (Flask, default GET) and `@x.api_route("/p", methods=[…])` (FastAPI).
 */
function routeDecorator(dec: Node): RouteDecorator | null {
  const call = dec.namedChild(0);
  if (call?.type !== "call") return null;
  const fn = call.childForFieldName("function");
  if (fn?.type !== "attribute") return null;
  const verb = fn.childForFieldName("attribute")?.text ?? "";
  const args = call.childForFieldName("arguments");
  const receiver = rootIdentifier(fn.childForFieldName("object")!);

  let methods: string[];
  if (HTTP_METHODS.has(verb.toLowerCase())) {
    methods = [verb.toUpperCase()];
  } else if (verb === "route" || verb === "api_route") {
    const listed = args ? stringArgs(keywordArg(args, "methods")) : [];
    methods = listed.length > 0 ? listed.map((m) => m.toUpperCase()) : ["GET"];
  } else {
    return null;
  }

  let path = "/";
  let pathTemplate: string | null = null;
  const first = args ? firstPositionalArg(args) : null;
  if (first) path = stripQuotes(first.text);
  // `@app.route(CLUBS_URL + "/<int:club_id>")`: names the project pass reads from the module defining them.
  if (first && first.type !== "string") {
    const t = pythonStringTemplate(first);
    if (t !== null && t.includes("${")) pathTemplate = t;
  }
  else if (args) {
    const named = literalKeywordArg(args, "path") ?? literalKeywordArg(args, "rule");
    if (named !== null) path = named;
  }
  const deps = args ? keywordArg(args, "dependencies") : null;
  const model = args ? keywordArg(args, "response_model") : null;
  const code = args ? keywordArg(args, "status_code") : null;
  const statusCode = code ? (/^\d{3}$/.test(code.text) ? Number(code.text) : Number(/HTTP_(\d{3})_/.exec(code.text)?.[1] ?? NaN)) : NaN;
  return {
    receiver,
    methods,
    path,
    pathTemplate,
    guards: deps ? guardsFromDependencies(deps) : [],
    responseModel: model && model.text !== "None" ? model.text : null,
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
    endpoint: (args ? stringKeyword(args, "endpoint", new Map()) : null) ?? null,
    azureRoute: args ? literalKeywordArg(args, "route") : null,
    methodsListed: !!args && stringArgs(keywordArg(args, "methods")).length > 0,
    authLevel: args ? keywordArg(args, "auth_level")?.text.replace(/^.*\./, "") ?? null : null,
  };
}

/** `@app.function_name(name="GetDriver")` → GetDriver. */
function azureFunctionName(dec: Node): string | null {
  const call = dec.namedChild(0);
  const fn = call?.type === "call" ? call.childForFieldName("function") : null;
  if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "function_name") return null;
  const args = call!.childForFieldName("arguments");
  const first = args ? firstPositionalArg(args) : null;
  return (args ? literalKeywordArg(args, "name") : null) ?? (first?.type === "string" ? stripQuotes(first.text) : null);
}

function joinPrefix(prefix: string, path: string): string {
  if (!prefix) return path;
  if (prefix.endsWith("/") && path.startsWith("/")) return prefix + path.slice(1);
  return prefix + path;
}

function walkForPythonRoutes(node: Node, routes: RouteInfo[], routers: Map<string, RouterDecl>): void {
  if (node.type === "decorated_definition") {
    const routeDecs: RouteDecorator[] = [];
    const guards: GuardAttr[] = [];
    let fnDef: Node | null = null;
    let functionName: string | null = null;
    for (const child of node.children) {
      if (child.type === "decorator") {
        functionName ??= azureFunctionName(child);
        const rd = routeDecorator(child);
        if (rd) routeDecs.push(rd);
        else {
          const g = guardFromDecorator(child);
          if (g) guards.push(g);
        }
      } else if (child.type === "function_definition") {
        fnDef = child;
      }
    }
    if (routeDecs.length > 0) {
      const handler = fnDef?.childForFieldName("name")?.text ?? null;
      for (const rd of routeDecs) {
        const router = rd.receiver ? routers.get(rd.receiver) : undefined;
        // Azure Functions: `route=` (else the function's name), any method unless `methods=` lists them.
        const azure = !!router?.azure && !!handler;
        if (azure) {
          if (!rd.methodsListed) rd.methods = ["ALL"];
          if (rd.authLevel) {
            const level = rd.authLevel.toLowerCase();
            guards.push(level === "anonymous" ? { text: `auth_level=${rd.authLevel}`, anonymous: true } : { text: `auth_level=${rd.authLevel}`, schemes: [`function-key:${level}`] });
          }
        }
        const path = azure ? azureFunctionPath(rd.azureRoute, functionName ?? handler!) : joinPrefix(router?.prefix ?? "", rd.path);
        const signature = fnDef ? signatureParams(fnDef, path) : { params: [], guards: [], dependencies: [] };
        const params = [...signature.params, ...bodyAccessParams(fnDef, path, signature.params)];
        // FastAPI's response: `response_model=`, else the return annotation (not a Response object), and `status_code=`.
        const annotated = fnDef?.childForFieldName("return_type")?.text;
        const bodyType = rd.responseModel ?? (annotated && !/^(?:None|Any|\w*Response)$/.test(annotated) ? annotated : null);
        const responses = bodyType || rd.statusCode !== null ? [{ status: rd.statusCode, ...(bodyType ? { type: bodyType } : {}) }] : undefined;
        for (const method of rd.methods) {
          const route: RouteInfo = {
            path,
            ...(rd.pathTemplate && !azure ? { pathTemplate: joinPrefix(router?.prefix ?? "", rd.pathTemplate) } : {}),
            httpMethod: method,
            kind: "api",
            handler,
            calls: signature.dependencies.map((c) => ({ ...c })),
            middleware: [],
            line: node.startPosition.row + 1,
            ...(responses ? { responses } : {}),
            // The name `url_for` builds its URL from, where the router is declared here.
            ...(router && (rd.endpoint ?? handler) ? { name: router.endpointPrefix + (rd.endpoint ?? handler) } : {}),
          };
          applyRouteMeta(route, {
            inheritedGuards: router?.guards,
            guards: [...rd.guards, ...guards, ...signature.guards],
            params,
          });
          routes.push(route);
        }
      }
    }
  }

  for (const child of node.children) {
    walkForPythonRoutes(child, routes, routers);
  }
}

// ─── Parameters: what FastAPI reads off the signature ─────────────────────

/** `Query(...)` / `Body(...)` … — the explicit binding markers. */
const MARKER_BINDINGS: Record<string, RouteParamBinding> = {
  Query: "query",
  Path: "route",
  Body: "body",
  Header: "header",
  Cookie: "header",
  Form: "form",
  File: "form",
  Depends: "services",
  Security: "services",
};

/** Types FastAPI binds by the type alone. */
const INJECTED_TYPES = new Set(["Request", "Response", "BackgroundTasks", "WebSocket", "HTTPConnection", "SecurityScopes"]);
const FORM_TYPES = new Set(["UploadFile"]);

/** Types FastAPI reads from the query string when nothing says otherwise; anything else is the body. */
const SIMPLE_TYPES = new Set([
  "int", "str", "float", "bool", "bytes", "UUID", "datetime", "date", "time", "timedelta", "Decimal",
  "EmailStr", "HttpUrl", "AnyUrl", "Any",
]);

function isSimpleType(typeText: string): boolean {
  const { type } = unwrapNullable(typeText);
  const g = splitGeneric(type);
  const name = g.name.replace(/^[\w.]*\./, "");
  if (g.args.length === 0) return SIMPLE_TYPES.has(name);
  if (/^(?:list|List|set|Set|Sequence|tuple|Tuple)$/.test(name)) return g.args.every((a) => a === "..." || isSimpleType(a));
  if (name === "Literal") return true;
  return false;
}

/** `Query(None)` → `Query`; anything that is not a marker call → null. */
function markerName(node: Node | null): string | null {
  if (node?.type !== "call") return null;
  const fn = node.childForFieldName("function");
  const name = fn?.type === "identifier" ? fn.text : fn?.type === "attribute" ? fn.childForFieldName("attribute")?.text : null;
  return name && name in MARKER_BINDINGS ? name : null;
}

/**
 * Bindings of the handler's parameters, FastAPI's way: an explicit marker as
 * the default (`q: str = Query(None)`) or inside `Annotated[str, Query()]`;
 * otherwise the framework's rule — a name the path declares → route, a
 * scalar type (or none) → query, a model type → body — marked `inferred`.
 * `Depends(x)` on an auth-looking callable is also a guard on the action.
 */
function signatureParams(fnDef: Node, path: string): { params: RouteParamInfo[]; guards: GuardAttr[]; dependencies: CallInfo[] } {
  const params: RouteParamInfo[] = [];
  const guards: GuardAttr[] = [];
  const dependencies: CallInfo[] = [];
  const paramsNode = fnDef.childForFieldName("parameters");
  const converters = pathConverterTypes(path);
  for (const p of paramsNode?.namedChildren ?? []) {
    let name: string | null = null;
    if (p.type === "identifier") name = p.text;
    else if (p.type === "typed_parameter") {
      const id = p.namedChild(0);
      name = id?.type === "identifier" ? id.text : null;
    } else if (p.type === "default_parameter" || p.type === "typed_default_parameter") {
      name = p.childForFieldName("name")?.text ?? null;
    }
    if (!name || name === "self" || name === "cls") continue;

    let type = p.childForFieldName("type")?.text.replace(/\s+/g, " ") ?? null;
    let marker: Node | null = p.childForFieldName("value");
    // `Annotated[T, Query(...)]` — the marker travels in the annotation.
    const typeNode = p.childForFieldName("type");
    const generic = typeNode?.namedChild(0);
    if (generic?.type === "generic_type" && generic.namedChild(0)?.text === "Annotated") {
      const members = generic.namedChild(1)?.namedChildren ?? [];
      type = members[0]?.text.replace(/\s+/g, " ") ?? type;
      for (const m of members.slice(1)) {
        const call = m.namedChild(0);
        if (markerName(call)) marker = call;
      }
    }
    if (type === null && converters.has(name)) type = converters.get(name)!;

    const mk = markerName(marker);
    if (mk) {
      params.push(boundParam(name, type, MARKER_BINDINGS[mk]!));
      if (mk === "Depends" || mk === "Security") {
        const guard = dependencyGuard(marker!);
        if (guard && (mk === "Security" || AUTH_DEPENDENCY.test(guard.policies![0]!))) guards.push(guard);
        // The framework calls a dependency named as a callable before the
        // handler runs (`Depends(get_club_from_path)`), so the route reaches
        // what it reads. A factory call (`Depends(get_repo(Clubs))`) is not one.
        const args = marker!.childForFieldName("arguments");
        const dep = args ? firstPositionalArg(args) : null;
        if (dep && (dep.type === "identifier" || dep.type === "attribute")) {
          dependencies.push({ name: dep.text, kind: "internal", target: null, line: dep.startPosition.row + 1 });
        }
      }
      continue;
    }

    const bare = type ? unwrapNullable(type).type.replace(/^[\w.]*\./, "") : null;
    if (bare && INJECTED_TYPES.has(bare)) {
      params.push({ name, type, binding: "services", inferred: true });
    } else if (bare && FORM_TYPES.has(splitGeneric(bare).name)) {
      params.push(boundParam(name, type, "form"));
    } else {
      params.push(inferredParam(name, type, path, type === null || isSimpleType(type) ? "query" : "body"));
    }
  }
  return { params, guards, dependencies };
}

/** Flask converters: `/x/<int:id>` → id: int. */
function pathConverterTypes(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of path.matchAll(/<([\w.]+)(?:\([^)]*\))?:([A-Za-z_]\w*)>/g)) out.set(m[2]!, m[1]!);
  return out;
}

/** What the body reads off `request` (Flask/Django), as inferred params not already in the signature. */
function bodyAccessParams(fnDef: Node | null, path: string, declared: readonly RouteParamInfo[]): RouteParamInfo[] {
  const body = fnDef?.childForFieldName("body");
  if (!body || !/\brequest\b/.test(body.text)) return [];
  const seen = new Set(declared.map((p) => `${p.binding}:${p.name}`));
  const out: RouteParamInfo[] = [];
  for (const acc of scanRequestAccess(body)) {
    const key = `${acc.binding}:${acc.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(inferredParam(acc.name, acc.type, path, acc.binding));
  }
  return out;
}

/** Route-registry adapter for this plugin (see routes/base.ts). */
export const pythonRouteExtractor: RouteExtractor = {
  languages: ["python"],
  extractRoutes(tree, sourceText, _filePath, facts) {
    const routes: RouteInfo[] = [];
    extractPythonRoutes(tree.rootNode, routes);
    // Code-first GraphQL (Strawberry, Graphene): the root fields a schema class serves.
    if (PY_GRAPHQL_GATE.test(sourceText)) extractPythonGraphqlRoutes(tree.rootNode, routes);
    // Django / DRF routing is only facts per file; `django-urlconf` joins them.
    if (facts && DJANGO_GATE.test(sourceText)) collectDjangoFacts(tree.rootNode, facts);
    return routes;
  },
};
