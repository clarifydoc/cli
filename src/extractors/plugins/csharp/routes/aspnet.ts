import type { Node } from "web-tree-sitter";
import type { RouteFact, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../../types/analysis.js";
import { findChildByType } from "../../../shared/node-helpers.js";
import { buildAuth, splitList, type GuardAttr } from "../../../shared/route-metadata.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { extractMinimalApiRoutes, MINIMAL_API_GATE } from "./minimal-api.js";
import { attributeDefFact, attributeUse, type CsAttrUse } from "./aspnet-attributes.js";

/**
 * ASP.NET attribute routing.
 *
 * A controller's full route is the **class-level** template merged with the
 * **method-level** template, with the `[controller]`/`[action]` tokens resolved
 * and route constraints stripped:
 *
 *   [Route("api/[controller]")]      class AccessReportController
 *     [HttpGet("roles/{roleId:guid}/holders")] GetRoleHolders
 *   ->  GET /api/AccessReport/roles/{roleId}/holders
 *
 * Earlier this extractor walked only `method_declaration` and read the path via
 * `attr.childForFieldName("arguments")` — but tree-sitter-c-sharp exposes the
 * argument list as a plain `attribute_argument_list` child, not an `arguments`
 * field, so the lookup always returned null and *every* route collapsed to "/".
 * It also never combined the class prefix, so the endpoint path was unusable
 * for the frontend→API join. Both are fixed here.
 */

const CSHARP_HTTP_ATTRIBUTES: Record<string, string> = {
  HttpGet: "GET",
  HttpPost: "POST",
  HttpPut: "PUT",
  HttpPatch: "PATCH",
  HttpDelete: "DELETE",
  HttpHead: "HEAD",
  HttpOptions: "OPTIONS",
};

/**
 * What the enclosing controller class contributes to every action: the route
 * prefix, the `[controller]` token, and the attribute layer that says who may
 * call it and in which API versions. Nested classes inherit the outer scope.
 */
interface ControllerScope {
  prefix: string | null;
  controllerName: string | null;
  /** The declaring class's own name (`SeriesController`) — every row's `owner`. */
  className: string | null;
  /** `[ApiController]` turns on ASP.NET's binding-source inference. */
  apiController: boolean;
  /** Class-level `[Authorize]`/`[AllowAnonymous]`, applied to every action. */
  guards: GuardAttr[];
  /** Class-level `[ApiVersion]` set (version → deprecated). */
  versions: Map<string, boolean>;
  versionNeutral: boolean;
}

const EMPTY_SCOPE: ControllerScope = {
  prefix: null,
  controllerName: null,
  className: null,
  apiController: false,
  guards: [],
  versions: new Map(),
  versionNeutral: false,
};

/**
 * What one controller class declares, for the project pass that resolves what
 * it INHERITS (`aspnet-resolver.ts`): ASP.NET attribute routing inherits a
 * base controller's `[Route]`, `[ApiController]` and `[Authorize]`, and a
 * base class's routed actions are served by every concrete subclass — none of
 * which one file can see when the base lives in another.
 */
export interface CsControllerFact {
  /** The class's base type as written (`BaseApiController`, `RestController<MovieResource>`). */
  base: string | null;
  abstract: boolean;
  /** Its own class-level `[Route]` template, tokens unresolved. */
  template: string | null;
  apiController: boolean;
  /** Its own class-level `[Authorize]` / `[AllowAnonymous]`. */
  guards: GuardAttr[];
  /** Each routed action: the verb attribute's line (the row's `line`), its own template and guards. */
  actions: CsActionFact[];
  /** Class-level attributes ASP.NET does not define — maybe the project's own `IRouteTemplateProvider`. */
  attrs?: CsAttrUse[];
  /** Methods routed, if at all, only by such attributes (`[RestPutById]`). */
  candidates?: CsCandidateFact[];
}

/** A method whose only routing could come from project attributes; the resolver decides. */
export interface CsCandidateFact {
  handler: string | null;
  attrs: CsAttrUse[];
  guards: GuardAttr[];
  /** Explicit `[From*]` bindings; the rest are inferred once the path is known. */
  params?: RouteParamInfo[];
  versions?: string[];
  deprecatedVersions?: string[];
}

export interface CsActionFact {
  line: number;
  verb: string;
  handler: string | null;
  template: string | null;
  guards: GuardAttr[];
}

export const CS_CONTROLLER_FACT = "cs:controller";

/** C#: [HttpGet("path")] / [Route("path")] with class-level prefix merging. */
export function extractAspnetRoutes(root: Node, routes: RouteInfo[], facts?: RouteFact[]): void {
  walkForCsharpRoutes(root, routes, EMPTY_SCOPE, facts);
}

function walkForCsharpRoutes(
  node: Node,
  routes: RouteInfo[],
  scope: ControllerScope,
  facts?: RouteFact[],
  /** The enclosing class's routed actions, collected for its fact. */
  actions?: CsActionFact[],
  candidates?: CsCandidateFact[],
) {
  if (node.type === "class_declaration") {
    const name = node.childForFieldName("name")?.text ?? null;
    const attrs = attributesOf(node);
    if (facts && name && /Attribute$/.test(name)) attributeDefFact(node, name, baseTypes(node), facts);
    const ownTemplate = classRoutePrefix(attrs);
    const ownApiController = attrs.some((a) => attributeName(a) === "ApiController");
    const ownGuards = guardAttributes(attrs);
    // ASP.NET strips the conventional "Controller" suffix for the [controller] token.
    const inner: ControllerScope = {
      prefix: ownTemplate ?? scope.prefix,
      controllerName: name ? name.replace(/Controller$/, "") : scope.controllerName,
      className: name ?? scope.className,
      apiController: scope.apiController || ownApiController,
      guards: [...scope.guards, ...ownGuards],
      versions: apiVersionsOf(attrs, scope.versions),
      versionNeutral: scope.versionNeutral || attrs.some((a) => attributeName(a) === "ApiVersionNeutral"),
    };
    const own: CsActionFact[] = [];
    const ownCandidates: CsCandidateFact[] = [];
    for (const child of node.children) {
      walkForCsharpRoutes(child, routes, inner, facts, own, ownCandidates);
    }
    const controllerish =
      own.length > 0 ||
      ownTemplate !== null ||
      ownApiController ||
      attrs.some((a) => attributeName(a) === "Controller") ||
      /Controller$/.test(name ?? "");
    if (facts && name && controllerish) {
      const data: CsControllerFact = {
        base: firstBaseType(node),
        abstract: node.children.some((c) => c.type === "modifier" && c.text === "abstract"),
        template: ownTemplate,
        apiController: ownApiController,
        guards: ownGuards,
        actions: own,
      };
      const custom = customAttributes(attrs);
      if (custom.length > 0) data.attrs = custom;
      if (ownCandidates.length > 0) data.candidates = ownCandidates;
      facts.push({ kind: CS_CONTROLLER_FACT, line: node.startPosition.row + 1, owner: name, data });
    }
    return;
  }

  if (node.type === "method_declaration") {
    parseMethodRoutes(node, routes, scope, actions, candidates);
    return;
  }

  for (const child of node.children) {
    walkForCsharpRoutes(child, routes, scope, facts, actions, candidates);
  }
}

/** Every type in a class's base list, as written. */
function baseTypes(cls: Node): string[] {
  const list = findChildByType(cls, "base_list");
  if (!list) return [];
  return list.namedChildren.filter((c) => c.type !== "comment" && c.type !== "argument_list").map((c) => c.text.replace(/\s+/g, ""));
}

/**
 * Attributes ASP.NET (or a common library) defines, whose meaning this
 * extractor already knows or which never route. Anything else may be the
 * project's own routing attribute and is recorded for the resolver.
 */
const KNOWN_ATTRIBUTES = new Set([
  "Route", ...Object.keys(CSHARP_HTTP_ATTRIBUTES), "AcceptVerbs", "ApiController", "Controller", "NonController", "NonAction",
  "Authorize", "AllowAnonymous", "ApiVersion", "ApiVersionNeutral", "MapToApiVersion", "Area",
  "Produces", "ProducesResponseType", "ProducesDefaultResponseType", "ProducesErrorResponseType", "Consumes",
  "ApiExplorerSettings", "Obsolete", "ResponseCache", "RequestSizeLimit", "DisableRequestSizeLimit", "RequestFormLimits",
  "ValidateAntiForgeryToken", "IgnoreAntiforgeryToken", "AutoValidateAntiforgeryToken", "EnableCors", "DisableCors",
  "ServiceFilter", "TypeFilter", "FormatFilter", "EnableRateLimiting", "DisableRateLimiting", "OutputCache",
  "SwaggerOperation", "SwaggerResponse", "SwaggerTag", "Description", "DisplayName", "Tags", "EndpointSummary",
  "EndpointDescription", "EndpointName", "ExcludeFromDescription", "DebuggerStepThrough", "DebuggerHidden",
  "SuppressMessage", "ExcludeFromCodeCoverage", "GeneratedCode", "AttributeUsage", "Serializable", "Fact", "Theory",
]);

function customAttributes(attrs: Node[]): CsAttrUse[] {
  const out: CsAttrUse[] = [];
  for (const attr of attrs) {
    const name = attributeName(attr);
    if (!name || KNOWN_ATTRIBUTES.has(name.replace(/Attribute$/, ""))) continue;
    out.push(attributeUse(attr, name.replace(/Attribute$/, "")));
  }
  return out;
}

/** First type in a class's base list (`: BaseApiController, IDisposable` → `BaseApiController`). */
function firstBaseType(cls: Node): string | null {
  const list = findChildByType(cls, "base_list");
  if (!list) return null;
  const first = list.namedChildren.find((c) => c.type !== "comment");
  return first ? first.text.replace(/\s+/g, "") : null;
}

/** Every `attribute` node directly on a declaration, across its attribute lists. */
function attributesOf(decl: Node): Node[] {
  const out: Node[] = [];
  for (const child of decl.children) {
    if (child.type !== "attribute_list") continue;
    for (const attr of child.children) {
      if (attr.type === "attribute") out.push(attr);
    }
  }
  return out;
}

/** First `[Route("…")]` template among a declaration's attributes (raw, tokens unresolved). */
function classRoutePrefix(attrs: Node[]): string | null {
  for (const attr of attrs) {
    if (attributeName(attr) === "Route") {
      const tmpl = attributeRouteTemplate(attr);
      if (tmpl !== null) return tmpl;
    }
  }
  return null;
}

/** Emit a RouteInfo for each HTTP-verb attribute on a method. */
function parseMethodRoutes(
  methodNode: Node,
  routes: RouteInfo[],
  scope: ControllerScope,
  actions?: CsActionFact[],
  candidates?: CsCandidateFact[],
) {
  const methodName = methodNode.childForFieldName("name")?.text ?? null;
  const attrs = attributesOf(methodNode);

  // First pass: a method-level [Route("…")] supplies the template for an
  // [HttpGet] that carries no template of its own (`[HttpGet][Route("x")]`).
  let routeAttrTemplate: string | null = null;
  const verbAttrs: { verb: string; template: string | null; line: number }[] = [];
  const mapToVersions: string[] = [];

  for (const attr of attrs) {
    const name = attributeName(attr);
    if (name === "Route") {
      routeAttrTemplate ??= attributeRouteTemplate(attr);
    } else if (name && CSHARP_HTTP_ATTRIBUTES[name]) {
      verbAttrs.push({
        verb: CSHARP_HTTP_ATTRIBUTES[name]!,
        template: attributeRouteTemplate(attr),
        line: attr.startPosition.row + 1,
      });
    } else if (name === "MapToApiVersion") {
      const v = positionalVersion(attr);
      if (v !== null) mapToVersions.push(v);
    }
  }
  if (verbAttrs.length === 0) {
    // Routed, if at all, by a project attribute declared elsewhere (`[RestPutById]`).
    if (!candidates || attrs.some((a) => attributeName(a) === "NonAction")) return;
    const custom = customAttributes(attrs);
    if (custom.length === 0) return;
    const candidate: CsCandidateFact = { handler: methodName, attrs: custom, guards: guardAttributes(attrs) };
    const params = parameterBindings(methodNode, "", false);
    if (params.length > 0) candidate.params = params;
    const versions = resolveVersions(scope, mapToVersions);
    if (versions) {
      candidate.versions = versions.all;
      if (versions.deprecated.length > 0) candidate.deprecatedVersions = versions.deprecated;
    }
    candidates.push(candidate);
    return;
  }

  const methodGuards = guardAttributes(attrs);
  const guards = [...scope.guards, ...methodGuards];
  const auth = buildAuth(scope.guards, methodGuards);
  const versions = resolveVersions(scope, mapToVersions);

  for (const { verb, template: own, line } of verbAttrs) {
    actions?.push({ line, verb, handler: methodName, template: own ?? routeAttrTemplate, guards: methodGuards });
    const path = buildPath(scope.prefix, own ?? routeAttrTemplate, scope.controllerName, methodName);
    const params = parameterBindings(methodNode, path, scope.apiController);
    const route: RouteInfo = {
      path,
      httpMethod: verb,
      kind: "api",
      handler: methodName,
      calls: [],
      middleware: guards.map((g) => g.text),
      line,
    };
    if (scope.className) route.owner = scope.className;
    if (auth) route.auth = auth;
    if (versions) {
      route.versions = versions.all;
      if (versions.deprecated.length > 0) route.deprecatedVersions = versions.deprecated;
    }
    if (params.length > 0) route.params = params;
    routes.push(route);
  }
}

// ─── Auth: [Authorize] / [AllowAnonymous] ──────────────────────────────────

function guardAttributes(attrs: Node[]): GuardAttr[] {
  const out: GuardAttr[] = [];
  for (const attr of attrs) {
    const name = attributeName(attr);
    if (name === "AllowAnonymous") {
      out.push({ text: "AllowAnonymous", anonymous: true, policies: [], roles: [], schemes: [] });
    } else if (name === "Authorize") {
      const named = namedArguments(attr);
      const policy = named.get("Policy") ?? positionalString(attr);
      out.push({
        text: attr.text.replace(/\s+/g, " "),
        anonymous: false,
        policies: policy ? [policy] : [],
        roles: splitList(named.get("Roles")),
        schemes: splitList(named.get("AuthenticationSchemes")),
      });
    }
  }
  return out;
}

// ─── Versions: [ApiVersion] / [MapToApiVersion] / [ApiVersionNeutral] ──────

/** Class-level `[ApiVersion("2", Deprecated = true)]` set, layered over the outer scope's. */
function apiVersionsOf(attrs: Node[], outer: Map<string, boolean>): Map<string, boolean> {
  const own = new Map<string, boolean>();
  for (const attr of attrs) {
    if (attributeName(attr) !== "ApiVersion") continue;
    const v = positionalVersion(attr);
    if (v === null) continue;
    const deprecated = namedArguments(attr).get("Deprecated") === "true";
    own.set(v, deprecated);
  }
  // A class that declares its own versions replaces the outer set (nested
  // controllers are rare; this is the ASP.NET semantic when they occur).
  return own.size > 0 ? own : outer;
}

function resolveVersions(
  scope: ControllerScope,
  mapTo: string[],
): { all: string[]; deprecated: string[] } | null {
  if (scope.versionNeutral) return null;
  if (mapTo.length > 0) {
    // `[MapToApiVersion]` narrows the action to a subset of the class's versions.
    return {
      all: mapTo,
      deprecated: mapTo.filter((v) => scope.versions.get(v) === true),
    };
  }
  if (scope.versions.size === 0) return null;
  const all = [...scope.versions.keys()];
  return { all, deprecated: all.filter((v) => scope.versions.get(v) === true) };
}

/** First positional argument of a version attribute as a string: `"2"` → "2", `2.0` → "2.0". */
function positionalVersion(attr: Node): string | null {
  const argList = findChildByType(attr, "attribute_argument_list");
  if (!argList) return null;
  for (const arg of argList.children) {
    if (arg.type !== "attribute_argument" || isNamedArgument(arg)) continue;
    const str = findChildByType(arg, "string_literal") ?? findChildByType(arg, "verbatim_string_literal");
    if (str) return stringLiteralText(str);
    const num = findChildByType(arg, "real_literal") ?? findChildByType(arg, "integer_literal");
    if (num) return num.text.replace(/[fFdDmM]$/, "");
    return null;
  }
  return null;
}

// ─── Parameters: [FromBody] / [FromQuery] / … ──────────────────────────────

const BINDING_ATTRIBUTES: Record<string, RouteParamBinding> = {
  FromBody: "body",
  FromQuery: "query",
  FromRoute: "route",
  FromHeader: "header",
  FromForm: "form",
  FromServices: "services",
  FromKeyedServices: "services",
};

/** Types ASP.NET binds from a single value (query/route), never from the body. */
const SIMPLE_TYPES = new Set([
  "string", "int", "long", "short", "byte", "sbyte", "uint", "ulong", "ushort",
  "bool", "double", "float", "decimal", "char", "object",
  "Guid", "DateTime", "DateTimeOffset", "DateOnly", "TimeOnly", "TimeSpan", "Uri",
  "Int32", "Int64", "Int16", "Boolean", "Double", "Single", "Decimal", "String", "Char", "Byte",
]);

/** Framework-supplied parameters that are never bound from the request. */
const UNBOUND_TYPES = new Set(["CancellationToken"]);

/**
 * Re-derive inferred bindings once a route's path or `[ApiController]` status
 * is known from an inherited scope. Explicit `[From*]` bindings never change;
 * an inferred or unknown one follows the same rules as at extraction.
 */
export function rebindParams(params: readonly RouteParamInfo[], path: string, apiController: boolean): RouteParamInfo[] {
  const routeParams = new Set([...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!.toLowerCase()));
  return params.map((p) => {
    if (p.binding !== null && !p.inferred) return p;
    let inferred: RouteParamBinding | null = null;
    if (routeParams.has(p.name.toLowerCase())) inferred = "route";
    else if (apiController) inferred = isSimpleType(p.type) ? "query" : "body";
    return inferred ? { name: p.name, type: p.type, binding: inferred, inferred: true } : { name: p.name, type: p.type, binding: null };
  });
}

function parameterBindings(methodNode: Node, path: string, apiController: boolean): RouteParamInfo[] {
  const paramsNode = methodNode.childForFieldName("parameters");
  if (!paramsNode) return [];
  const routeParams = new Set(
    [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!.toLowerCase()),
  );
  const out: RouteParamInfo[] = [];
  for (const p of paramsNode.children) {
    if (p.type !== "parameter") continue;
    const name = p.childForFieldName("name")?.text ?? p.text;
    const type = p.childForFieldName("type")?.text ?? null;
    if (type && UNBOUND_TYPES.has(type)) continue;

    let binding: RouteParamBinding | null = null;
    for (const attr of attributesOf(p)) {
      const b = BINDING_ATTRIBUTES[attributeName(attr) ?? ""];
      if (b) {
        binding = b;
        break;
      }
    }
    if (binding) {
      out.push({ name, type, binding });
      continue;
    }
    // ASP.NET's default inference: a name matching a route token binds from the
    // route; under [ApiController] a complex type binds from the body and a
    // simple one from the query. Without [ApiController] only the route rule
    // is safe to state.
    let inferred: RouteParamBinding | null = null;
    if (routeParams.has(name.toLowerCase())) inferred = "route";
    else if (apiController) inferred = isSimpleType(type) ? "query" : "body";
    out.push(inferred ? { name, type, binding: inferred, inferred: true } : { name, type, binding: null });
  }
  return out;
}

function isSimpleType(type: string | null): boolean {
  if (!type) return true;
  const bare = type.replace(/\?$/, "").replace(/^System\./, "");
  if (SIMPLE_TYPES.has(bare)) return true;
  // `int[]` / `List<string>` / `IEnumerable<Guid>`: arrays of simple values bind from the query.
  const elem = bare.match(/^(?:[A-Za-z]+<)?([A-Za-z.]+)>?(?:\[\])?$/)?.[1];
  return elem !== undefined && elem !== bare && SIMPLE_TYPES.has(elem.replace(/^System\./, ""));
}

// ─── Attribute argument helpers ────────────────────────────────────────────

/** A named argument (`Deprecated = true`) has an `=` token between name and value. */
function isNamedArgument(arg: Node): boolean {
  return arg.children.some((c) => c.type === "=");
}

/**
 * Named arguments of an attribute as `name → value text`, with the common
 * value shapes reduced to what a reader wants: string literals unquoted,
 * `nameof(X.Y)` → `X.Y`, `typeof(T)` → `T`, anything else verbatim.
 */
function namedArguments(attr: Node): Map<string, string> {
  const out = new Map<string, string>();
  const argList = findChildByType(attr, "attribute_argument_list");
  if (!argList) return out;
  for (const arg of argList.children) {
    if (arg.type !== "attribute_argument" || !isNamedArgument(arg)) continue;
    const name = arg.children[0];
    const value = arg.children[arg.children.length - 1];
    if (!name || !value) continue;
    out.set(name.text, argumentValueText(value));
  }
  return out;
}

/** First positional string argument, unquoted (`[Authorize("Policy")]`). */
function positionalString(attr: Node): string | null {
  const argList = findChildByType(attr, "attribute_argument_list");
  if (!argList) return null;
  for (const arg of argList.children) {
    if (arg.type !== "attribute_argument" || isNamedArgument(arg)) continue;
    const str = findChildByType(arg, "string_literal") ?? findChildByType(arg, "verbatim_string_literal");
    return str ? stringLiteralText(str) : null;
  }
  return null;
}

function argumentValueText(value: Node): string {
  if (value.type === "string_literal" || value.type === "verbatim_string_literal") {
    return stringLiteralText(value);
  }
  if (value.type === "invocation_expression") {
    // nameof(Rettighed.Vikardaekke) → Rettighed.Vikardaekke
    const callee = value.childForFieldName("function")?.text ?? value.children[0]?.text;
    if (callee === "nameof") {
      const args = findChildByType(value, "argument_list");
      const inner = args?.children.find((c) => c.type === "argument");
      if (inner) return inner.text;
    }
  }
  if (value.type === "typeof_expression") {
    return value.children.find((c) => c.type !== "typeof" && c.type !== "(" && c.type !== ")")?.text ?? value.text;
  }
  return value.text;
}

/** Simple (last-segment) name of a C# attribute, e.g. `Mvc.HttpGet` -> `HttpGet`. */
function attributeName(attr: Node): string | null {
  const name = attr.childForFieldName("name")?.text ?? null;
  if (!name) return null;
  return name.replace(/.*\./, "");
}

/**
 * The route template from an attribute: the first **positional** string
 * argument. Named arguments (`Name = "…"`, `Order = 2`) are wrapped in an
 * `assignment_expression`, so a positional template is the `attribute_argument`
 * whose child is a bare `string_literal`.
 */
function attributeRouteTemplate(attr: Node): string | null {
  const argList = findChildByType(attr, "attribute_argument_list");
  if (!argList) return null;
  for (const arg of argList.children) {
    if (arg.type !== "attribute_argument") continue;
    const str = findChildByType(arg, "string_literal")
      ?? findChildByType(arg, "verbatim_string_literal");
    if (str) return stringLiteralText(str);
  }
  return null;
}

/** Inner text of a C# string literal (handles the `string_literal_content` child + `@"…"`). */
function stringLiteralText(str: Node): string {
  const content = findChildByType(str, "string_literal_content");
  if (content) return content.text;
  return str.text.replace(/^@?"/, "").replace(/"$/, "");
}

/** Resolve `[controller]`/`[action]` tokens in a template segment. */
function substituteTokens(
  s: string,
  controllerName: string | null,
  methodName: string | null,
): string {
  let out = s;
  if (controllerName) out = out.replace(/\[controller\]/gi, controllerName);
  if (methodName) out = out.replace(/\[action\]/gi, methodName);
  return out;
}

/** Strip route constraints/defaults/catch-all markers: `{id:guid}` / `{id?}` / `{*slug}` -> `{id}`/`{slug}`. */
function stripConstraints(path: string): string {
  return path.replace(/\{\*{0,2}([^}:=?]+)[^}]*\}/g, "{$1}");
}

/** Build the full, normalized endpoint path for one route. */
export function buildPath(
  classPrefix: string | null,
  template: string | null,
  controllerName: string | null,
  methodName: string | null,
): string {
  const prefix = substituteTokens(classPrefix ?? "", controllerName, methodName);
  const tmpl = substituteTokens(template ?? "", controllerName, methodName);

  // A template starting with "/" or "~/" is absolute — it ignores the prefix.
  let merged: string;
  if (tmpl.startsWith("/") || tmpl.startsWith("~/")) {
    merged = tmpl.replace(/^~/, "");
  } else if (!prefix) {
    merged = tmpl;
  } else if (!tmpl) {
    merged = prefix;
  } else {
    merged = prefix.replace(/\/+$/, "") + "/" + tmpl.replace(/^\/+/, "");
  }

  let path = stripConstraints(merged);
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

/** Route-registry adapter for this plugin (see routes/base.ts). */
// Every route this extractor can produce comes from a `[Http*]`/`[Route]`
// attribute; `[^\]]` spans newlines, so multi-line attribute lists still match.
const ROUTE_ATTRIBUTE_GATE = /\[[^\]]*\b(?:Http(?:Get|Post|Put|Patch|Delete|Head|Options)|Route)\b/;
// A controller with no route attribute of its own — it inherits its template
// and perhaps its actions — still needs its fact recorded.
const CONTROLLER_CLASS_GATE = /\bclass\s+\w*Controller\b|\[\s*(?:Api)?Controller\b/;
// A project's own routing attribute (`class V3ApiControllerAttribute : …`).
const ATTRIBUTE_CLASS_GATE = /\bclass\s+\w+Attribute\s*:/;

export const csharpRouteExtractor: RouteExtractor = {
  languages: ["csharp"],
  extractRoutes(tree, sourceText, _filePath, facts) {
    // Cheap gate: skip the full-tree walk for files with no route attributes.
    const minimal = MINIMAL_API_GATE.test(sourceText);
    if (!minimal && !ROUTE_ATTRIBUTE_GATE.test(sourceText) && !CONTROLLER_CLASS_GATE.test(sourceText) && !ATTRIBUTE_CLASS_GATE.test(sourceText)) {
      return [];
    }
    const routes: RouteInfo[] = [];
    extractAspnetRoutes(tree.rootNode, routes, facts);
    // Minimal APIs (`app.MapGet("/x", Handler)`, see minimal-api.ts).
    if (minimal) extractMinimalApiRoutes(tree.rootNode, routes);
    return routes;
  },
};
