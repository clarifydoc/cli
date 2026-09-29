import type { Node } from "web-tree-sitter";
import type { RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";
import { applyRouteMeta, boundParam, inferredParam, type GuardAttr } from "../../shared/route-metadata.js";
import { HTTP_METHODS } from "../../routes/base.js";
import type { RouteExtractor } from "../../routes/base.js";
import { scanRequestAccess } from "./request-access.js";
import { splitGeneric, unwrapNullable } from "./request-schema.js";

/**
 * Python: `@app.get("/path")` (FastAPI, Flask ≥2), `@bp.route("/path", methods=[…])`
 * (Flask), plus the attribute layer each declares — router-level and
 * per-route `dependencies=[Depends(…)]`, Flask/Django guard decorators, and
 * the parameter bindings FastAPI reads off the handler signature.
 */
export function extractPythonRoutes(root: Node, routes: RouteInfo[]): void {
  const routers = collectRouterDecls(root);
  walkForPythonRoutes(root, routes, routers);
  walkForRouterMounts(root, routes);
}

/**
 * FastAPI router mounts: `router.include_router(auth.router, prefix="/users")`.
 *
 * The prefix lives here, in the wiring file, while the endpoints it applies to
 * are decorated in the module being mounted — so on its own this file's routes
 * look prefix-less and several routers' `@router.get("")` all collapse to the
 * same empty path. Emitted in the shape `resolveRouterMounts` already consumes
 * for Express (`kind: "api"`, `httpMethod: null`, `handler` = the identifier to
 * resolve through the import index), which then applies the prefix across files.
 *
 * Only mounts with a LITERAL `prefix=` are emitted. `include_router(x.router)`
 * contributes no prefix, and `prefix=settings.api_prefix` is a value this
 * analysis cannot know; emitting either would leave an unresolvable non-endpoint
 * sitting in the route map, which is worse than the prefix it failed to supply.
 */
function walkForRouterMounts(node: Node, routes: RouteInfo[]): void {
  if (node.type === "call") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "include_router") {
      const args = node.childForFieldName("arguments");
      const router = args ? firstPositionalArg(args) : null;
      const prefix = args ? literalKeywordArg(args, "prefix") : null;
      // `auth.router` → "auth", the name the import index can resolve.
      const handler = router ? rootIdentifier(router) : null;
      if (handler && prefix !== null) {
        routes.push({
          path: prefix,
          httpMethod: null,
          kind: "api",
          handler,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
        });
      }
    }
  }
  for (const child of node.children) walkForRouterMounts(child, routes);
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
}

const ROUTER_CTORS = new Set(["APIRouter", "Blueprint", "FastAPI", "Flask"]);

/**
 * Module-level `name = APIRouter(...)` / `Blueprint(...)` assignments, keyed by
 * the variable a decorator will name as its receiver. Same file only: a router
 * imported from elsewhere carries its prefix through `include_router`, not here.
 */
function collectRouterDecls(root: Node): Map<string, RouterDecl> {
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
    if (!ctorName || !ROUTER_CTORS.has(ctorName)) continue;
    const args = right.childForFieldName("arguments");
    const prefix = args ? (literalKeywordArg(args, "prefix") ?? literalKeywordArg(args, "url_prefix") ?? "") : "";
    const deps = args ? keywordArg(args, "dependencies") : null;
    decls.set(left.text, { prefix, guards: deps ? guardsFromDependencies(deps) : [] });
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
  /** `dependencies=[…]` on the decorator. */
  guards: GuardAttr[];
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
  const first = args ? firstPositionalArg(args) : null;
  if (first) path = stripQuotes(first.text);
  else if (args) {
    const named = literalKeywordArg(args, "path") ?? literalKeywordArg(args, "rule");
    if (named !== null) path = named;
  }
  const deps = args ? keywordArg(args, "dependencies") : null;
  return { receiver, methods, path, guards: deps ? guardsFromDependencies(deps) : [] };
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
    for (const child of node.children) {
      if (child.type === "decorator") {
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
        const path = joinPrefix(router?.prefix ?? "", rd.path);
        const signature = fnDef ? signatureParams(fnDef, path) : { params: [], guards: [] };
        const params = [...signature.params, ...bodyAccessParams(fnDef, path, signature.params)];
        for (const method of rd.methods) {
          const route: RouteInfo = {
            path,
            httpMethod: method,
            kind: "api",
            handler,
            calls: [],
            middleware: [],
            line: node.startPosition.row + 1,
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
function signatureParams(fnDef: Node, path: string): { params: RouteParamInfo[]; guards: GuardAttr[] } {
  const params: RouteParamInfo[] = [];
  const guards: GuardAttr[] = [];
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
  return { params, guards };
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
  extractRoutes(tree, _sourceText) {
    const routes: RouteInfo[] = [];
    extractPythonRoutes(tree.rootNode, routes);
    return routes;
  },
};
