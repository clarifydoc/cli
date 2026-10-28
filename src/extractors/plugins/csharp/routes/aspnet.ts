import { constantString } from "../constant-expr.js";
import type { Node } from "web-tree-sitter";
import type { RouteFact, RouteInfo, RouteParamBinding, RouteParamInfo, RouteResponseInfo } from "../../../../types/analysis.js";
import { findChildByType } from "../../../shared/node-helpers.js";
import { buildAuth, filterKind, routeFilters, splitList, type GuardAttr } from "../../../shared/route-metadata.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { collectGroupCalls, extractMinimalApiRoutes, GROUP_CALL_GATE, MINIMAL_API_GATE } from "./minimal-api.js";
import { AZURE_FUNCTIONS_GATE, extractAzureFunctionRoutes } from "./azure-functions.js";
import { attributeDefFact, attributeUse, type CsAttrUse } from "./aspnet-attributes.js";
import { CONVENTIONAL_ROUTE_GATE, extractConventionalPatterns, webApiVerb } from "./aspnet-conventional.js";
import { collectHotChocolateFacts } from "../graphql.js";

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
  /** The class-level template when it is a constant declared elsewhere (`[Route(ApiRoutes.Base)]`), as `${…}` holes. */
  prefixTemplate?: string | null;
  controllerName: string | null;
  /** The declaring class's own name (`SeriesController`) — every row's `owner`. */
  className: string | null;
  /** `[ApiController]` turns on ASP.NET's binding-source inference. */
  apiController: boolean;
  /** Class-level `[Authorize]`/`[AllowAnonymous]`, applied to every action. */
  guards: GuardAttr[];
  /** Class-level filter attributes (`[EnableRateLimiting("fixed")]`, `[ValidateAntiForgeryToken]`), as written. */
  filters?: string[];
  /** Class-level `[ApiVersion]` set (version → deprecated). */
  versions: Map<string, boolean>;
  versionNeutral: boolean;
  /** The file is Web API 2 (`using System.Web.Http`): an action without a verb attribute takes the verb its name starts with. */
  webApi: boolean;
}

const EMPTY_SCOPE: ControllerScope = {
  prefix: null,
  controllerName: null,
  className: null,
  apiController: false,
  guards: [],
  versions: new Map(),
  versionNeutral: false,
  webApi: false,
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
  /** `[Area("Admin")]`: the `{area}` a conventional route serves it under. */
  area?: string;
  /**
   * Public actions with no route attribute of their own, on a class with no
   * class template: reached, if at all, through a conventional route the
   * startup registers (`{controller}/{action}/{id?}`) — the resolver decides.
   */
  conventional?: CsConventionalAction[];
}

export interface CsConventionalAction {
  handler: string;
  /** `[ActionName("Delete")]`, else the method's name. */
  action: string;
  line: number;
  guards: GuardAttr[];
  params?: RouteParamInfo[];
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
  /** Null: any verb (a method-level `[Route]` alone). */
  verb: string | null;
  handler: string | null;
  /** `[ActionName("Delete")]` — the `[action]` / `{action}` it answers to, when not the method's name. */
  action?: string;
  template: string | null;
  guards: GuardAttr[];
}

export const CS_CONTROLLER_FACT = "cs:controller";

/** C#: [HttpGet("path")] / [Route("path")] with class-level prefix merging. */
export function extractAspnetRoutes(root: Node, routes: RouteInfo[], facts?: RouteFact[], sourceText = ""): void {
  const scope = /^\s*using\s+System\.Web\.Http\s*;/m.test(sourceText) ? { ...EMPTY_SCOPE, webApi: true } : EMPTY_SCOPE;
  walkForCsharpRoutes(root, routes, scope, facts);
  if (facts) extractConventionalPatterns(root, sourceText, facts);
}

function walkForCsharpRoutes(
  node: Node,
  routes: RouteInfo[],
  scope: ControllerScope,
  facts?: RouteFact[],
  /** The enclosing class's routed actions, collected for its fact. */
  actions?: CsActionFact[],
  candidates?: CsCandidateFact[],
  conventional?: CsConventionalAction[],
) {
  if (node.type === "class_declaration") {
    const name = node.childForFieldName("name")?.text ?? null;
    const attrs = attributesOf(node);
    if (facts && name && /Attribute$/.test(name)) attributeDefFact(node, name, baseTypes(node), facts);
    const ownTemplate = classRoutePrefix(attrs);
    // `[Route(ApiRoutes.Base)]`: a constant the project pass reads from the class declaring it.
    const ownConstant = ownTemplate === null ? classRouteConstant(attrs) : null;
    const ownApiController = attrs.some((a) => attributeName(a) === "ApiController");
    const ownGuards = guardAttributes(attrs);
    // ASP.NET strips the conventional "Controller" suffix for the [controller] token.
    const inner: ControllerScope = {
      prefix: ownTemplate ?? scope.prefix,
      prefixTemplate: ownTemplate !== null ? null : ownConstant ?? scope.prefixTemplate ?? null,
      controllerName: name ? name.replace(/Controller$/, "") : scope.controllerName,
      className: name ?? scope.className,
      apiController: scope.apiController || ownApiController,
      guards: [...scope.guards, ...ownGuards],
      filters: [...(scope.filters ?? []), ...filterAttributes(attrs)],
      versions: apiVersionsOf(attrs, scope.versions),
      versionNeutral: scope.versionNeutral || attrs.some((a) => attributeName(a) === "ApiVersionNeutral"),
      webApi: scope.webApi,
    };
    const own: CsActionFact[] = [];
    const ownCandidates: CsCandidateFact[] = [];
    const isAbstract = node.children.some((c) => c.type === "modifier" && c.text === "abstract");
    // Attribute routing and conventional routing never mix on one controller:
    // only a class with no template of its own (nor [ApiController], which
    // demands attribute routes) offers its plain actions to the route table.
    // An abstract base's are kept too: every controller deriving from it serves them.
    const ownConventional: CsConventionalAction[] | undefined =
      ownTemplate === null && ownConstant === null && !ownApiController && /Controller$/.test(name ?? "") ? [] : undefined;
    for (const child of node.children) {
      walkForCsharpRoutes(child, routes, inner, facts, own, ownCandidates, ownConventional);
    }
    const controllerish =
      own.length > 0 ||
      ownTemplate !== null ||
      ownConstant !== null ||
      ownApiController ||
      attrs.some((a) => attributeName(a) === "Controller") ||
      /Controller$/.test(name ?? "");
    if (facts && name && controllerish) {
      const data: CsControllerFact = {
        base: firstBaseType(node),
        abstract: isAbstract,
        template: ownTemplate,
        apiController: ownApiController,
        guards: ownGuards,
        actions: own,
      };
      const custom = customAttributes(attrs);
      if (custom.length > 0) data.attrs = custom;
      if (ownCandidates.length > 0) data.candidates = ownCandidates;
      const area = attrs.find((a) => attributeName(a) === "Area");
      const areaName = area ? positionalString(area) : null;
      if (areaName) data.area = areaName;
      if (ownConventional && ownConventional.length > 0) data.conventional = ownConventional;
      facts.push({ kind: CS_CONTROLLER_FACT, line: node.startPosition.row + 1, owner: name, data });
    }
    return;
  }

  if (node.type === "method_declaration") {
    parseMethodRoutes(node, routes, scope, actions, candidates, conventional);
    return;
  }

  for (const child of node.children) {
    walkForCsharpRoutes(child, routes, scope, facts, actions, candidates, conventional);
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
  "Route", "RoutePrefix", ...Object.keys(CSHARP_HTTP_ATTRIBUTES), "AcceptVerbs", "ApiController", "Controller", "NonController", "NonAction",
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

/** First `[Route("…")]` — or Web API 2's `[RoutePrefix("…")]` — template among a declaration's attributes (raw, tokens unresolved). */
function classRoutePrefix(attrs: Node[]): string | null {
  for (const attr of attrs) {
    const name = attributeName(attr);
    if (name === "Route" || name === "RoutePrefix") {
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
  conventional?: CsConventionalAction[],
) {
  const methodName = methodNode.childForFieldName("name")?.text ?? null;
  const attrs = attributesOf(methodNode);

  // First pass: a method-level [Route("…")] supplies the template for an
  // [HttpGet] that carries no template of its own (`[HttpGet][Route("x")]`).
  let routeAttrTemplate: string | null = null;
  let routeAttrConstant: string | null = null;
  let routeAttrLine = 0;
  let actionName: string | null = null;
  const verbAttrs: { verb: string | null; template: string | null; constant?: string | null; line: number }[] = [];
  const mapToVersions: string[] = [];

  for (const attr of attrs) {
    const name = attributeName(attr);
    if (name === "Route") {
      if (routeAttrTemplate === null && routeAttrConstant === null) {
        routeAttrTemplate = attributeRouteTemplate(attr);
        routeAttrConstant = routeAttrTemplate === null ? attributeConstantTemplate(attr) : null;
        routeAttrLine = attr.startPosition.row + 1;
      }
    } else if (name === "ActionName") {
      actionName = positionalString(attr);
    } else if (name && CSHARP_HTTP_ATTRIBUTES[name]) {
      const template = attributeRouteTemplate(attr);
      verbAttrs.push({
        verb: CSHARP_HTTP_ATTRIBUTES[name]!,
        template,
        constant: template === null ? attributeConstantTemplate(attr) : null,
        line: attr.startPosition.row + 1,
      });
    } else if (name === "MapToApiVersion") {
      const v = positionalVersion(attr);
      if (v !== null) mapToVersions.push(v);
    }
  }
  // `[Route("x")]` alone routes every verb — Web API 2 picks the one the name starts with.
  if (verbAttrs.length === 0 && (routeAttrTemplate !== null || routeAttrConstant !== null)) {
    verbAttrs.push({ verb: scope.webApi && methodName ? webApiVerb(methodName) : null, template: routeAttrTemplate, constant: routeAttrConstant, line: routeAttrLine });
  }
  if (verbAttrs.length === 0) {
    if (conventional && methodName && isPlainAction(methodNode, attrs)) {
      const action: CsConventionalAction = { handler: methodName, action: actionName ?? methodName, line: methodNode.startPosition.row + 1, guards: guardAttributes(attrs) };
      const params = parameterBindings(methodNode, "", false);
      if (params.length > 0) action.params = params;
      conventional.push(action);
    }
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

  for (const { verb, template: own, constant, line } of verbAttrs) {
    actions?.push({ line, verb, handler: methodName, template: own ?? routeAttrTemplate, guards: methodGuards, ...(actionName ? { action: actionName } : {}) });
    const path = buildPath(scope.prefix, own ?? routeAttrTemplate, scope.controllerName, actionName ?? methodName);
    const params = parameterBindings(methodNode, path, scope.apiController);
    const shorter = optionalTailPath(scope.prefix, own ?? routeAttrTemplate, scope.controllerName, actionName ?? methodName);
    const route: RouteInfo = {
      path,
      httpMethod: verb,
      kind: "api",
      handler: methodName,
      calls: [],
      middleware: guards.map((g) => g.text),
      line,
      ...(shorter && shorter !== path ? { aliases: [shorter] } : {}),
    };
    // A template (or class template) that is a constant declared elsewhere: the project pass reads it.
    const methodConstant = constant ?? (own === null ? routeAttrConstant : null);
    if (methodConstant || scope.prefixTemplate) {
      route.pathTemplate = buildPath(scope.prefixTemplate ?? scope.prefix, methodConstant ?? own ?? routeAttrTemplate, scope.controllerName, actionName ?? methodName);
    }
    if (scope.className) route.owner = scope.className;
    if (auth) route.auth = auth;
    if (versions) {
      route.versions = versions.all;
      if (versions.deprecated.length > 0) route.deprecatedVersions = versions.deprecated;
    }
    if (params.length > 0) route.params = params;
    const filters = [...routeFilters(scope.filters ?? [], true), ...routeFilters(filterAttributes(attrs), false)];
    if (filters.length > 0) route.filters = filters;
    const responses = actionResponses(methodNode, attrs);
    if (responses) route.responses = responses;
    routes.push(route);
  }
}

/** `StatusCodes.Status201Created` / `201` / `HttpStatusCode.Created`. */
const NAMED_STATUS: Record<string, number> = { OK: 200, Created: 201, Accepted: 202, NoContent: 204, BadRequest: 400, Unauthorized: 401, Forbidden: 403, NotFound: 404, Conflict: 409 };
function statusText(text: string): number | null {
  const m = /Status(\d{3})\w*|\b(\d{3})\b|HttpStatusCode\.(\w+)/.exec(text);
  if (!m) return null;
  return m[1] ? Number(m[1]) : m[2] ? Number(m[2]) : NAMED_STATUS[m[3]!] ?? null;
}
/** The result helpers a controller returns, by the status they send. */
const RESULT_HELPERS: Record<string, number> = {
  Ok: 200, Created: 201, CreatedAtAction: 201, CreatedAtRoute: 201, Accepted: 202, AcceptedAtAction: 202, NoContent: 204,
  BadRequest: 400, Unauthorized: 401, Forbid: 403, NotFound: 404, Conflict: 409, UnprocessableEntity: 422,
};
const RESULT_WRAPPERS = /^(?:Task|ValueTask|ActionResult|Results)<([\s\S]+)>$/;

/**
 * What an action answers: `[ProducesResponseType(typeof(T), 201)]`, the
 * declared return type (`Task<ActionResult<UserDto>>` → `UserDto`; an
 * `IActionResult` says nothing), and the result helpers the body returns
 * (`return NotFound();`, `return CreatedAtAction(…, dto);`).
 */
function actionResponses(method: Node, attrs: readonly Node[]): RouteResponseInfo[] | undefined {
  const out: RouteResponseInfo[] = [];
  for (const attr of attrs) {
    if (attributeName(attr) !== "ProducesResponseType") continue;
    const type = /typeof\(\s*([\w.<>,\[\]\s]+?)\s*\)/.exec(attr.text)?.[1]?.replace(/\s+/g, "");
    const status = statusText(attr.text.replace(/typeof\([^)]*\)/, ""));
    out.push({ status, ...(type ? { type } : {}) });
  }
  let type = method.childForFieldName("returns")?.text?.replace(/\s+/g, "") ?? method.childForFieldName("type")?.text?.replace(/\s+/g, "") ?? null;
  for (let i = 0; type && i < 3; i++) {
    const m = RESULT_WRAPPERS.exec(type);
    if (!m) break;
    type = m[1]!;
  }
  if (type && /^(?:void|Task|ValueTask|I?ActionResult|IResult|object|dynamic)$/.test(type)) type = null;
  if (type && !out.some((r) => r.type)) out.push({ status: null, type });
  const body = method.childForFieldName("body");
  for (const m of (body?.text ?? "").matchAll(/\breturn\s+(?:this\.)?([A-Z]\w*)\s*\(/g)) {
    const status = RESULT_HELPERS[m[1]!];
    if (status !== undefined && !out.some((r) => r.status === status)) out.push({ status });
  }
  return out.length > 0 ? out : undefined;
}

/** The controller base classes' own virtual hooks — overriding one makes no action. */
const CONTROLLER_HOOKS = /^(?:On[A-Z]\w*|Dispose|Initialize|Execute\w*|BeginExecute\w*|EndExecute\w*|HandleUnknownAction|CreateActionInvoker|Create\w*Provider)$/;

/**
 * A method ASP.NET treats as an action: public, an instance method (an
 * override of a virtual action is one; of a framework hook like
 * `OnActionExecuting`, not), not generic, not `[NonAction]`.
 */
function isPlainAction(methodNode: Node, attrs: Node[]): boolean {
  const mods = methodNode.children.filter((c) => c.type === "modifier").map((c) => c.text);
  if (!mods.includes("public") || mods.some((m) => m === "static" || m === "abstract" || m === "extern")) return false;
  if (methodNode.childForFieldName("type_parameters") || findChildByType(methodNode, "type_parameter_list")) return false;
  if (attrs.some((a) => attributeName(a) === "NonAction")) return false;
  const name = methodNode.childForFieldName("name")?.text ?? "";
  return !(CONTROLLER_HOOKS.test(name) && (mods.includes("override") || name === "Dispose"));
}

// ─── Filters: rate limits, CORS, antiforgery, caching, service filters ──────

/** The attributes that filter a request besides auth, as written: `EnableRateLimiting("fixed")`, `ServiceFilter(typeof(AuditFilter))`. */
function filterAttributes(attrs: Node[]): string[] {
  const out: string[] = [];
  for (const attr of attrs) {
    const name = attributeName(attr);
    if (!name || name === "Authorize" || name === "AllowAnonymous") continue;
    const text = attr.text.replace(/\s+/g, " ");
    if (filterKind(text)) out.push(text);
  }
  return out;
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
  const routeParams = new Set([...path.matchAll(/\{\*?([^}]+)\}/g)].map((m) => m[1]!.toLowerCase()));
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
    [...path.matchAll(/\{\*?([^}]+)\}/g)].map((m) => m[1]!.toLowerCase()),
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
    // nameof(Permission.ManageSquad) → Permission.ManageSquad
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

/**
 * An attribute's first positional argument when it is a constant expression
 * rather than a literal — `[HttpGet(ApiRoutes.Club)]`, `[Route(Routes.Base + "/clubs")]`
 * — with each constant a `${…}` hole (an attribute argument is always a
 * compile-time constant, so any name in it is one). Null without one.
 */
function attributeConstantTemplate(attr: Node): string | null {
  const argList = findChildByType(attr, "attribute_argument_list");
  if (!argList) return null;
  for (const arg of argList.children) {
    if (arg.type !== "attribute_argument") continue;
    if (arg.namedChildren.some((c) => c.type === "name_equals" || c.type === "name_colon" || c.type === "assignment_expression")) continue;
    const t = constantString(arg.namedChildren[0] ?? null);
    return t !== null && t.includes("${") ? t : null;
  }
  return null;
}

/** First class-level `[Route(…)]` / `[RoutePrefix(…)]` whose template is a constant expression. */
function classRouteConstant(attrs: Node[]): string | null {
  for (const attr of attrs) {
    const name = attributeName(attr);
    if (name === "Route" || name === "RoutePrefix") return attributeConstantTemplate(attr);
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

/**
 * Strip route constraints and defaults: `{id:guid}` / `{id?}` -> `{id}`. A
 * catch-all keeps one marker (`{**slug:nonfile}` -> `{*slug}`): it takes the
 * rest of the path, slashes included.
 */
function stripConstraints(path: string): string {
  return path.replace(/\{(\*{0,2})([^}:=?]+)[^}]*\}/g, (_m, star: string, name: string) => `{${star ? "*" : ""}${name}}`);
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

/**
 * The path the route also answers when its template ends in an optional parameter —
 * `[HttpPut("{id:int?}")]` serves `PUT /api/clubs` as well as `PUT /api/clubs/5` — or null.
 */
export function optionalTailPath(
  classPrefix: string | null,
  template: string | null,
  controllerName: string | null,
  methodName: string | null,
): string | null {
  const tail = /(?:^|\/)\{[^}]*\?\}\/?$/.exec(template ?? "");
  if (!tail) return null;
  const shorter = (template ?? "").slice(0, tail.index);
  // Nothing left of an absolute template is the site root, not the prefix.
  return buildPath(classPrefix, shorter === "" && template!.startsWith("/") ? "/" : shorter, controllerName, methodName);
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

/**
 * `Routing.RegisterRoute("Basket", typeof(BasketView))` / `(nameof(BasketView), typeof(BasketView))`:
 * a page `GoToAsync("Basket")` pushes — a frontend route at `/Basket` whose component is the view class.
 */
function registeredShellRoutes(sourceText: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const m of sourceText.matchAll(/\bRouting\.RegisterRoute\(\s*(?:nameof\(\s*([\w.]+)\s*\)|\$?"([^"]+)")\s*,\s*typeof\(\s*([\w.]+)\s*\)\s*\)/g)) {
    const name = (m[2] ?? m[1]!.split(".").pop()!).replace(/^\/+/, "");
    const view = m[3]!.split(".").pop()!;
    const line = sourceText.slice(0, m.index).split("\n").length;
    routes.push({ path: "/" + name, httpMethod: null, kind: "frontend", handler: view, componentPath: view, calls: [], middleware: [], line });
  }
  return routes;
}

export const csharpRouteExtractor: RouteExtractor = {
  languages: ["csharp"],
  extractRoutes(tree, sourceText, _filePath, facts) {
    // MAUI Shell routes registered in code: `Routing.RegisterRoute("Basket", typeof(BasketView))`.
    const shell = sourceText.includes("RegisterRoute(") ? registeredShellRoutes(sourceText) : [];
    // HotChocolate root-type registrations (`AddQueryType<Query>()`), for hotChocolateResolver.
    collectHotChocolateFacts(sourceText, facts);
    // `app.MapClubsApi().RequireAuthorization()`: a guard on the group a project method returns.
    if (facts && GROUP_CALL_GATE.test(sourceText)) collectGroupCalls(tree.rootNode, facts);
    // Cheap gate: skip the full-tree walk for files with no route attributes.
    const minimal = MINIMAL_API_GATE.test(sourceText);
    const azure = AZURE_FUNCTIONS_GATE.test(sourceText);
    if (
      !minimal &&
      !azure &&
      !ROUTE_ATTRIBUTE_GATE.test(sourceText) &&
      !CONTROLLER_CLASS_GATE.test(sourceText) &&
      !ATTRIBUTE_CLASS_GATE.test(sourceText) &&
      !CONVENTIONAL_ROUTE_GATE.test(sourceText)
    ) {
      return shell;
    }
    const routes: RouteInfo[] = [...shell];
    extractAspnetRoutes(tree.rootNode, routes, facts, sourceText);
    // Minimal APIs (`app.MapGet("/x", Handler)`, see minimal-api.ts).
    if (minimal) extractMinimalApiRoutes(tree.rootNode, routes, facts);
    // Azure Functions HTTP triggers (see azure-functions.ts).
    if (azure) extractAzureFunctionRoutes(tree.rootNode, routes);
    return routes;
  },
};
