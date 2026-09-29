import type { ClassInfo, FunctionInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import { applyRouteMeta, boundParam, inferredParam, splitList, type GuardAttr } from "../../shared/route-metadata.js";
import { attributeLinesAbove, splitTopLevel, type RegexLangSpec } from "../shared/regex-base.js";
import { isSimpleType, readVbType, splitVbAttributes, UNBOUND_TYPES, vbAttributeName, vbNamedArgs, vbPositionalArg } from "./request-schema.js";

/**
 * ASP.NET attribute routing in VB.NET — the same attribute layer the C#
 * extractor reads (`csharp/routes/aspnet.ts`), spelled `<…>`:
 *
 *   <Route("api/users")> <ApiVersion("2")> <Authorize>
 *   Public Class UsersController
 *       <HttpGet("{id}")> <AllowAnonymous>
 *       Public Function [Get](id As Integer) As IHttpActionResult
 *       <HttpPost("")>
 *       Public Function Post(<FromBody> request As CreateUserRequest) As IHttpActionResult
 *
 * Class-level guards and versions are inherited by every action; an action's
 * own `<Authorize>`/`<AllowAnonymous>` adds to or waives them, and
 * `<MapToApiVersion>` narrows the class's version set. A parameter binds
 * where its `<FromX>` says; without one, a name the template declares comes
 * from the route, a simple type from the query and a complex type from the
 * body (Web API 2 and `[ApiController]` both bind that way for VB projects).
 *
 * Attributes sit on their own line above the declaration (possibly several,
 * possibly with a ` _` continuation) or inline at the start of it; both are
 * read. Convention-routed `XxxController` classes without any attribute keep
 * the Index/Get/Post/Put/Delete mapping.
 */

const VERB_ATTRIBUTES: Record<string, string> = {
  HttpGet: "GET",
  HttpPost: "POST",
  HttpPut: "PUT",
  HttpPatch: "PATCH",
  HttpDelete: "DELETE",
  HttpHead: "HEAD",
  HttpOptions: "OPTIONS",
};

const BINDING_ATTRIBUTES: Record<string, RouteParamBinding> = {
  FromBody: "body",
  FromQuery: "query",
  FromUri: "query",
  FromRoute: "route",
  FromHeader: "header",
  FromForm: "form",
  FromServices: "services",
  FromKeyedServices: "services",
};

/** Own-line attributes above `lineIdx` plus the inline `<…>` lists that open the line itself. */
function attributesAt(lines: string[], lineIdx: number, spec: RegexLangSpec): string[] {
  const out = attributeLinesAbove(lines, lineIdx, spec).flatMap((d) => splitVbAttributes(d));
  let rest = lines[lineIdx] ?? "";
  let m: RegExpMatchArray | null;
  while ((m = rest.match(/^\s*<([^<>]*(?:"[^"]*"[^<>]*)*)>\s*/))) {
    out.push(...splitVbAttributes(m[1]!));
    rest = rest.slice(m[0].length);
  }
  return out;
}

// ─── Auth: <Authorize> / <AllowAnonymous> ──────────────────────────────────

function guardAttributes(attrs: string[]): GuardAttr[] {
  const out: GuardAttr[] = [];
  for (const attr of attrs) {
    const name = vbAttributeName(attr);
    if (name === "AllowAnonymous") {
      out.push({ text: "AllowAnonymous", anonymous: true, policies: [], roles: [], schemes: [] });
    } else if (name === "Authorize") {
      const named = vbNamedArgs(attr);
      const policy = named.get("Policy") ?? vbPositionalArg(attr);
      out.push({
        text: attr,
        anonymous: false,
        policies: policy ? [policy] : [],
        roles: splitList(named.get("Roles")),
        schemes: splitList(named.get("AuthenticationSchemes")),
      });
    }
  }
  return out;
}

// ─── Versions: <ApiVersion> / <MapToApiVersion> / <ApiVersionNeutral> ──────

function apiVersionsOf(attrs: string[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const attr of attrs) {
    if (vbAttributeName(attr) !== "ApiVersion") continue;
    const v = vbPositionalArg(attr);
    if (v === null) continue;
    out.set(v, /^true$/i.test(vbNamedArgs(attr).get("Deprecated") ?? ""));
  }
  return out;
}

function resolveVersions(
  classVersions: Map<string, boolean>,
  neutral: boolean,
  mapTo: string[],
): { all: string[]; deprecated: string[] } | null {
  if (neutral) return null;
  if (mapTo.length > 0) return { all: mapTo, deprecated: mapTo.filter((v) => classVersions.get(v) === true) };
  if (classVersions.size === 0) return null;
  const all = [...classVersions.keys()];
  return { all, deprecated: all.filter((v) => classVersions.get(v) === true) };
}

// ─── Parameters: <FromBody> / <FromQuery> / … ──────────────────────────────

/**
 * The parameter list of the method declared at `lines[lineIdx]` — balanced
 * `(…)` after the (possibly `[escaped]`) name, across wrapped lines — with
 * each parameter's own `<Attr>` prefix, name and full type.
 */
function declaredParams(lines: string[], lineIdx: number, name: string): { attrs: string[]; name: string; type: string | null }[] {
  const first = lines[lineIdx] ?? "";
  const nameAt = first.search(new RegExp(`(?:^|[^\\w])\\[?${name}\\]?\\s*\\(`));
  if (nameAt < 0) return [];
  const open = first.indexOf("(", nameAt + 1);
  let text = "";
  let depth = 0;
  let closed = false;
  for (let li = lineIdx; li < Math.min(lines.length, lineIdx + 12) && !closed; li++) {
    const line = lines[li]!.replace(/\s+_\s*$/, "");
    for (let c = li === lineIdx ? open : 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === "(") {
        depth++;
        if (depth === 1) continue;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          closed = true;
          break;
        }
      }
      text += ch;
    }
    if (!closed) text += " ";
  }
  if (!closed) return [];

  const out: { attrs: string[]; name: string; type: string | null }[] = [];
  for (const piece of splitTopLevel(text)) {
    let param = piece.trim();
    const attrs: string[] = [];
    let a: RegExpMatchArray | null;
    while ((a = param.match(/^<([^<>]*(?:"[^"]*"[^<>]*)*)>\s*/))) {
      attrs.push(...splitVbAttributes(a[1]!));
      param = param.slice(a[0].length);
    }
    const m = param.match(/^(?:(?:ByVal|ByRef|Optional|ParamArray)\s+)*(\w+)(?:\s+As\s+)?/i);
    if (!m) continue;
    const type = /\bAs\s*$/i.test(m[0]) ? readVbType(param, m[0].length)?.type ?? null : null;
    out.push({ attrs, name: m[1]!, type });
  }
  return out;
}

function parameterBindings(lines: string[], method: FunctionInfo, path: string): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  for (const p of declaredParams(lines, method.line - 1, method.name)) {
    if (p.type && UNBOUND_TYPES.has(p.type.toLowerCase())) continue;
    let explicit: RouteParamBinding | null = null;
    for (const attr of p.attrs) {
      const b = BINDING_ATTRIBUTES[vbAttributeName(attr)];
      if (b) {
        explicit = b;
        break;
      }
    }
    out.push(explicit ? boundParam(p.name, p.type, explicit) : inferredParam(p.name, p.type, path, isSimpleType(p.type) ? "query" : "body"));
  }
  return out;
}

// ─── Routes ────────────────────────────────────────────────────────────────

function routeTemplate(attr: string): string | null {
  return vbPositionalArg(attr);
}

function joinPath(base: string, template: string): string {
  const tmpl = template.startsWith("~/") ? template.slice(1) : template;
  const merged = tmpl.startsWith("/") ? tmpl : base.replace(/\/+$/, "") + "/" + tmpl.replace(/^\/+/, "");
  let path = merged.replace(/\{\*{0,2}([^}:=?]+)[^}]*\}/g, "{$1}");
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

/** Convention-based action mapping for `XxxController` classes without route attributes. */
const ACTION_MAP: Record<string, { method: string; suffix: string }> = {
  Index: { method: "GET", suffix: "" },
  Get: { method: "GET", suffix: "/{id}" },
  GetAll: { method: "GET", suffix: "" },
  Post: { method: "POST", suffix: "" },
  Create: { method: "POST", suffix: "" },
  Put: { method: "PUT", suffix: "/{id}" },
  Update: { method: "PUT", suffix: "/{id}" },
  Delete: { method: "DELETE", suffix: "/{id}" },
};

export function extractVbRoutes(lines: string[], classes: ClassInfo[], spec: RegexLangSpec): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const cls of classes) {
    const classAttrs = attributesAt(lines, cls.line - 1, spec);
    const controllerName = cls.name.replace(/Controller$/, "");
    const substitute = (s: string, action: string) =>
      s.replace(/\[controller\]/gi, controllerName).replace(/\[action\]/gi, action);
    const classRoute = classAttrs.map((a) => (vbAttributeName(a) === "Route" || vbAttributeName(a) === "RoutePrefix" ? routeTemplate(a) : null)).find((t) => t !== null) ?? null;
    const classGuards = guardAttributes(classAttrs);
    const classVersions = apiVersionsOf(classAttrs);
    const neutral = classAttrs.some((a) => vbAttributeName(a) === "ApiVersionNeutral");

    let explicit = 0;
    for (const method of cls.methods) {
      const attrs = attributesAt(lines, method.line - 1, spec);
      let routeAttr: string | null = null;
      const verbs: { verb: string; template: string | null }[] = [];
      const mapTo: string[] = [];
      for (const attr of attrs) {
        const name = vbAttributeName(attr);
        if (name === "Route") routeAttr ??= routeTemplate(attr) ?? "";
        else if (VERB_ATTRIBUTES[name]) verbs.push({ verb: VERB_ATTRIBUTES[name]!, template: routeTemplate(attr) });
        else if (name === "MapToApiVersion") {
          const v = vbPositionalArg(attr);
          if (v !== null) mapTo.push(v);
        }
      }
      if (verbs.length === 0 && routeAttr === null) continue;
      explicit++;

      const emit = (verb: string | null, template: string | null) => {
        const base = classRoute !== null ? "/" + substitute(classRoute, method.name).replace(/^\/+/, "") : "";
        const path = joinPath(base, substitute(template ?? "", method.name));
        const route: RouteInfo = {
          path,
          httpMethod: verb,
          kind: "api",
          handler: method.name,
          calls: method.calls,
          middleware: [],
          line: method.line,
        };
        const versions = resolveVersions(classVersions, neutral, mapTo);
        applyRouteMeta(route, {
          inheritedGuards: classGuards,
          guards: guardAttributes(attrs),
          versions: versions?.all,
          deprecatedVersions: versions?.deprecated,
          params: parameterBindings(lines, method, path),
        });
        routes.push(route);
      };
      if (verbs.length > 0) for (const v of verbs) emit(v.verb, v.template ?? routeAttr);
      else emit(null, routeAttr);
    }

    // Convention-based fallback: XxxController methods without explicit route attrs
    const match = cls.name.match(/^(\w+?)Controller$/);
    if (!match || explicit > 0 || cls.name === "Controller" || cls.name === "ApiController") continue;
    const resource = match[1]!.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    const basePath = classRoute !== null ? "/" + classRoute.replace(/^\/+/, "") : "/" + resource;
    for (const method of cls.methods) {
      if (!method.isExported || method.name.startsWith("_") || method.name === "New") continue;
      const action = ACTION_MAP[method.name];
      if (!action) continue;
      const path = basePath + action.suffix;
      const route: RouteInfo = {
        path,
        httpMethod: action.method,
        kind: "api",
        handler: method.name,
        calls: method.calls,
        middleware: [],
        line: method.line,
      };
      const versions = resolveVersions(classVersions, neutral, []);
      applyRouteMeta(route, {
        inheritedGuards: classGuards,
        guards: guardAttributes(attributesAt(lines, method.line - 1, spec)),
        versions: versions?.all,
        deprecatedVersions: versions?.deprecated,
        params: parameterBindings(lines, method, path),
      });
      routes.push(route);
    }
  }

  return routes;
}
