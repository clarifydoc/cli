import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { applyRouteMeta, boundParam, inferredParam, type GuardAttr } from "../../../shared/route-metadata.js";

/**
 * NestJS decorator routing.
 *
 * A route is a `@Get('path')`-style decorator sitting in a `class_body` as a
 * SIBLING of the method it decorates (tree-sitter-typescript keeps method
 * decorators outside `method_definition`), so the handler is the next
 * `method_definition` after the decorator run — not, as before, the first
 * method in the class (usually `constructor`). The full path is the
 * `@Controller('prefix')` of the enclosing class joined with the method path.
 *
 * The attribute layer comes from the same decorators: `@UseGuards(...)`,
 * `@Roles(...)`, `@Public()` on the class (inherited) or the method,
 * `@Version(...)` on either (the method's wins), and the parameter decorators
 * `@Body() / @Query() / @Param() / @Headers() / @UploadedFile() / @Req()`,
 * which are CHILDREN of the parameter node.
 */

const HTTP_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "All", "Head", "Options"]);

/** `@Public()`, `@AllowAnonymous()`, `@SkipAuth()` — the usual custom "no guard here" markers. */
const ANONYMOUS_DECORATORS = new Set(["Public", "AllowAnonymous", "SkipAuth", "SkipJwtAuth", "NoAuth", "IsPublic"]);

/** Parameter decorator → binding. */
const PARAM_BINDINGS: Record<string, RouteParamBinding> = {
  Body: "body",
  Query: "query",
  Param: "route",
  Headers: "header",
  UploadedFile: "form",
  UploadedFiles: "form",
  Req: "services",
  Request: "services",
  Res: "services",
  Response: "services",
  Session: "services",
  Ip: "services",
  HostParam: "services",
  Next: "services",
};

/** NestJS-style decorators: @Get("/path"), @Post("/path") */
export function extractNestjsRoutes(root: Node, routes: RouteInfo[]): void {
  walkForDecoratorRoutes(root, routes);
}

function walkForDecoratorRoutes(node: Node, routes: RouteInfo[]) {
  visitNestjsRoute(node, routes);
  for (const child of node.children) {
    walkForDecoratorRoutes(child, routes);
  }
}

/** The `call_expression` inside a decorator, with its bare callee name; null for `@foo` without a call. */
function decoratorCall(dec: Node): { name: string; call: Node } | null {
  const expr = dec.namedChildren[0];
  if (!expr || expr.type !== "call_expression") return null;
  const callee = expr.childForFieldName("function");
  if (!callee) return null;
  // `@common.Get()` — keep the leaf.
  const name = callee.type === "member_expression" ? callee.childForFieldName("property")?.text ?? "" : callee.text;
  return { name, call: expr };
}

/** Decorator text as a reader knows it: `UseGuards(AuthGuard('jwt'), RolesGuard)`. */
function decoratorText(dec: Node): string {
  return dec.text.replace(/^@/, "").replace(/\s+/g, " ").trim();
}

/** Argument nodes of a call, punctuation excluded. */
function callArgs(call: Node): Node[] {
  return call.childForFieldName("arguments")?.namedChildren ?? [];
}

/** First string argument of a call, or null. */
function firstString(call: Node): string | null {
  const first = callArgs(call)[0];
  if (!first) return null;
  if (first.type === "string" || first.type === "template_string") return stripQuotes(first.text);
  // `@Get(['a', 'b'])` — the first alternative.
  if (first.type === "array") {
    const el = first.namedChildren[0];
    if (el && (el.type === "string" || el.type === "template_string")) return stripQuotes(el.text);
  }
  return null;
}

/** Every string in an argument list, flattening one array level: `'2'`, `['2', '3']`. */
function allStrings(call: Node): string[] {
  const out: string[] = [];
  for (const a of callArgs(call)) {
    if (a.type === "string" || a.type === "template_string") out.push(stripQuotes(a.text));
    else if (a.type === "array") {
      for (const el of a.namedChildren) {
        if (el.type === "string" || el.type === "template_string") out.push(stripQuotes(el.text));
      }
    }
  }
  return out;
}

/** `{ path: 'users', version: '1' }` → the string value of one key, or null. */
function objectStringField(obj: Node, key: string): string | null {
  for (const pair of obj.namedChildren) {
    if (pair.type !== "pair") continue;
    if (pair.childForFieldName("key")?.text !== key) continue;
    const value = pair.childForFieldName("value");
    if (!value) return null;
    if (value.type === "string" || value.type === "template_string") return stripQuotes(value.text);
    if (value.type === "array") {
      const el = value.namedChildren[0];
      if (el && (el.type === "string" || el.type === "template_string")) return stripQuotes(el.text);
    }
    return null;
  }
  return null;
}

/**
 * The guard a class- or method-level decorator declares, or null for one
 * that says nothing about access (`@HttpCode`, `@ApiTags`, `@Get`).
 */
function guardOf(dec: Node): GuardAttr | null {
  const d = decoratorCall(dec);
  if (!d) return null;
  const text = decoratorText(dec);
  if (ANONYMOUS_DECORATORS.has(d.name)) return { text, anonymous: true };
  if (d.name === "Roles") return { text, roles: allStrings(d.call) };
  if (d.name === "UseGuards") {
    const schemes: string[] = [];
    const policies: string[] = [];
    for (const arg of callArgs(d.call)) {
      if (arg.type === "call_expression") {
        // `AuthGuard('jwt')` — the strategy is the scheme; `AuthGuard()` is a policy by name.
        const callee = arg.childForFieldName("function")?.text ?? arg.text;
        const strings = callArgs(arg)
          .filter((a) => a.type === "string" || a.type === "template_string")
          .map((a) => stripQuotes(a.text));
        if (/AuthGuard$/.test(callee) && strings.length > 0) schemes.push(...strings);
        else policies.push(callee.replace(/\s+/g, ""));
      } else if (arg.type === "new_expression") {
        policies.push(arg.childForFieldName("constructor")?.text ?? arg.text);
      } else {
        policies.push(arg.text);
      }
    }
    return { text, schemes, policies };
  }
  return null;
}

/** `@Version('2')` / `@Version(['2', '3'])`; `VERSION_NEUTRAL` and other identifiers contribute nothing. */
function versionsOf(dec: Node): string[] {
  const d = decoratorCall(dec);
  return d && d.name === "Version" ? allStrings(d.call) : [];
}

/** What the enclosing controller contributes to every route in it. */
interface ControllerScope {
  prefix: string;
  /** `@Controller(RouteKey.Asset)`: the prefix is another file's enum member, resolved project-wide. */
  prefixRef?: string;
  guards: GuardAttr[];
  versions: string[];
  /** `@UseInterceptors`, `@UsePipes`, `@UseFilters`, `@Throttle` on the controller, as written. */
  filters: string[];
}

/** Decorators that filter a request besides guards, as written: `UsePipes(ValidationPipe)`, `Throttle({ default: … })`. */
const FILTER_DECORATORS = new Set(["UseInterceptors", "UsePipes", "UseFilters", "Throttle", "SkipThrottle", "CacheTTL", "CacheKey"]);
function filterOf(dec: Node): string | undefined {
  const d = decoratorCall(dec);
  return d && FILTER_DECORATORS.has(d.name) ? dec.text.replace(/^@/, "").replace(/\s+/g, " ") : undefined;
}

/**
 * Decorators of the class that owns a `class_body`: children of the class
 * node, or of its `export_statement` parent when the class is exported.
 */
function classDecorators(classBody: Node): Node[] {
  const cls = classBody.parent;
  if (!cls) return [];
  const own = cls.children.filter((c) => c.type === "decorator");
  if (own.length > 0) return own;
  const parent = cls.parent;
  if (parent?.type === "export_statement") return parent.children.filter((c) => c.type === "decorator");
  return [];
}

function controllerScope(classBody: Node): ControllerScope {
  const scope: ControllerScope = { prefix: "", guards: [], versions: [], filters: [] };
  for (const dec of classDecorators(classBody)) {
    const d = decoratorCall(dec);
    if (!d) continue;
    if (d.name === "Controller") {
      const first = callArgs(d.call)[0];
      if (first?.type === "object") {
        scope.prefix = objectStringField(first, "path") ?? "";
        const v = objectStringField(first, "version");
        if (v) scope.versions.push(v);
      } else if (first?.type === "member_expression" && /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(first.text)) {
        scope.prefixRef = first.text;
      } else {
        scope.prefix = firstString(d.call) ?? "";
      }
      continue;
    }
    const guard = guardOf(dec);
    if (guard) scope.guards.push(guard);
    const filter = filterOf(dec);
    if (filter) scope.filters.push(filter);
    scope.versions.push(...versionsOf(dec));
  }
  return scope;
}

/** `users` + `:id` → `/users/:id`; empty parts collapse to `/`. */
function joinPath(prefix: string, path: string): string {
  const parts = [prefix, path].map((p) => p.replace(/^\/+|\/+$/g, "")).filter((p) => p.length > 0);
  return "/" + parts.join("/");
}

/** The decorator run this decorator belongs to (contiguous decorator siblings) and the method after it. */
function decoratorRun(dec: Node): { decorators: Node[]; method: Node | null } {
  const siblings = dec.parent?.children ?? [];
  let at = siblings.findIndex((s) => s.id === dec.id);
  if (at < 0) return { decorators: [dec], method: null };
  // Walk back to the start of the run, then forward to the method.
  let start = at;
  while (start > 0 && siblings[start - 1]!.type === "decorator") start--;
  const decorators: Node[] = [];
  let method: Node | null = null;
  for (let i = start; i < siblings.length; i++) {
    const s = siblings[i]!;
    if (s.type === "decorator") decorators.push(s);
    else {
      if (s.type === "method_definition") method = s;
      break;
    }
  }
  return { decorators, method };
}

/** One route parameter from a method parameter node (`@Body() dto: CreateUserDto`, `@Param('id') id: string`, `plain: number`). */
function paramOf(param: Node, fullPath: string): RouteParamInfo | null {
  const ident = param.childForFieldName("pattern") ?? param.namedChildren.find((c) => c.type === "identifier");
  const name = ident?.text;
  if (!name) return null;
  const type = param.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null;
  const dec = param.namedChildren.find((c) => c.type === "decorator");
  if (!dec) return inferredParam(name, type, fullPath, null);
  const d = decoratorCall(dec);
  if (!d) return { name, type, binding: null };
  const binding = PARAM_BINDINGS[d.name];
  if (!binding) return { name, type, binding: null };
  // Framework-injected objects are always an inference from the reader's
  // point of view: nothing about the request binds there.
  if (binding === "services") return { name, type, binding, inferred: true };
  // `@Query('q') q`, `@Param('id') id`, `@Headers('x-t') t` — the string names
  // the wire key; `@Body('name')` a body field.
  return boundParam(firstString(d.call) ?? name, type, binding);
}

/** The `HttpStatus` members `@HttpCode` is most often given. */
const HTTP_STATUS: Record<string, number> = {
  OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, MOVED_PERMANENTLY: 301, FOUND: 302,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
};

/** Inspect a single node for a NestJS HTTP-verb decorator. */
/** A route whose controller prefix is an enum member (`@Controller(RouteKey.Asset)`), for `nestPrefixResolver`. */
export const NEST_PREFIX_FACT = "nest-prefix-ref";

export function visitNestjsRoute(node: Node, routes: RouteInfo[], facts?: RouteFact[]): void {
  if (node.type !== "decorator") return;
  const d = decoratorCall(node);
  if (!d || !HTTP_DECORATORS.has(d.name)) return;
  const classBody = node.parent;
  if (!classBody || classBody.type !== "class_body") return;

  const scope = controllerScope(classBody);
  const { decorators, method } = decoratorRun(node);
  const fullPath = joinPath(scope.prefix, firstString(d.call) ?? "");

  const guards: GuardAttr[] = [];
  const methodVersions: string[] = [];
  const filters: string[] = [];
  for (const dec of decorators) {
    const guard = guardOf(dec);
    if (guard) guards.push(guard);
    const filter = filterOf(dec);
    if (filter) filters.push(filter);
    methodVersions.push(...versionsOf(dec));
  }

  const params: RouteParamInfo[] = [];
  if (method) {
    for (const p of method.childForFieldName("parameters")?.namedChildren ?? []) {
      if (p.type !== "required_parameter" && p.type !== "optional_parameter") continue;
      const info = paramOf(p, fullPath);
      if (info) params.push(info);
    }
  }

  // `@HttpCode(201)` and the declared return type (`Promise<UserDto>`): what the action answers.
  let status: number | null = d.name === "Post" ? 201 : null;
  for (const dec of decorators) {
    const c = decoratorCall(dec);
    if (c?.name === "HttpCode") {
      const arg = c.call.childForFieldName("arguments")?.namedChildren[0];
      if (arg && /^\d{3}$/.test(arg.text)) status = Number(arg.text);
      else if (arg && /HttpStatus\.(\w+)/.test(arg.text)) status = HTTP_STATUS[/HttpStatus\.(\w+)/.exec(arg.text)![1]!] ?? status;
    }
  }
  const returnType = method?.childForFieldName("return_type")?.text?.replace(/^:\s*/, "").trim();
  const bodyType = returnType && !/^(?:Promise<\s*)?(?:void|any|unknown)\s*>?$/.test(returnType) ? returnType : undefined;
  if (scope.prefixRef) facts?.push({ kind: NEST_PREFIX_FACT, line: node.startPosition.row + 1, data: { ref: scope.prefixRef, path: fullPath } });
  const route: RouteInfo = {
    path: fullPath,
    httpMethod: d.name.toUpperCase(),
    kind: "api",
    handler: method?.childForFieldName("name")?.text ?? null,
    calls: [],
    middleware: [],
    line: node.startPosition.row + 1,
    ...(bodyType || status !== null ? { responses: [{ status, ...(bodyType ? { type: bodyType } : {}) }] } : {}),
  };
  applyRouteMeta(route, {
    inheritedGuards: scope.guards,
    guards,
    // A method-level @Version overrides the controller's.
    versions: methodVersions.length > 0 ? methodVersions : scope.versions,
    params,
    inheritedFilters: scope.filters,
    filters,
  });
  routes.push(route);
}

/**
 * `@Controller(RouteKey.Asset)` where `enum RouteKey { Asset = 'assets' }` sits
 * in another file: every route of that controller is served under the member's
 * value. The enum is the one of that name in the controller's sub-project, else
 * in the project; a name two enums share there is left alone.
 */
export const nestPrefixResolver: RouteResolver = {
  id: "nest-enum-prefix",
  languages: ["typescript", "javascript"],
  priority: 40,
  resolve(analyses: FileAnalysis[]): void {
    const pending = analyses.filter((a) => a.routeFacts?.some((f) => f.kind === NEST_PREFIX_FACT));
    if (pending.length === 0) return;
    const enums = new Map<string, Array<{ project: string | undefined; values: Record<string, string> }>>();
    for (const a of analyses) {
      for (const c of a.classes) {
        if (c.kind !== "enum" || !c.fieldValues) continue;
        (enums.get(c.name) ?? enums.set(c.name, []).get(c.name)!).push({ project: a.projectId, values: c.fieldValues });
      }
    }
    for (const a of pending) {
      for (const f of a.routeFacts!) {
        if (f.kind !== NEST_PREFIX_FACT) continue;
        const { ref, path } = f.data as { ref: string; path: string };
        const [enumName, member] = ref.split(".") as [string, string];
        const all = enums.get(enumName) ?? [];
        const local = all.filter((e) => e.project === a.projectId);
        const pick = local.length > 0 ? local : all;
        if (pick.length !== 1) continue;
        const prefix = pick[0]!.values[member];
        if (prefix === undefined) continue;
        for (const r of a.routes) if (r.line === f.line && r.path === path) r.path = joinPath(prefix, path);
      }
    }
  },
};
