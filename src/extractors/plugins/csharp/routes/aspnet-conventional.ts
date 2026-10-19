import type { Node } from "web-tree-sitter";
import type { RouteFact } from "../../../../types/analysis.js";

/**
 * ASP.NET conventional routing — the route table a startup file registers,
 * through which every controller without attribute routes is reached:
 *
 *   app.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");
 *   app.MapDefaultControllerRoute();                     // the same pattern
 *   app.MapAreaControllerRoute("admin", "Admin", "Admin/{controller}/{action}");
 *   routes.MapRoute("Default", "{controller}/{action}/{id}",
 *     new { controller = "Home", id = UrlParameter.Optional });   // MVC 5
 *   config.Routes.MapHttpRoute("DefaultApi", "api/{controller}/{id}",
 *     new { id = RouteParameter.Optional });                       // Web API 2
 *
 * Each registration is a `cs:conventional-route` fact; the controller
 * resolver (aspnet-resolver.ts) applies them to the actions per sub-project.
 */
export const CS_CONVENTIONAL_ROUTE_FACT = "cs:conventional-route";

export interface CsConventionalPattern {
  /** The template as written (`{controller=Home}/{action=Index}/{id?}`). */
  pattern: string;
  /** Parameters a `defaults` object or an inline `=`/`?` makes optional. */
  optional: string[];
  /** `MapAreaControllerRoute`'s area name. */
  area?: string;
  /** Web API 2's `MapHttpRoute`: the action is chosen by HTTP verb, not by `{action}`. */
  webApi?: boolean;
}

export const CONVENTIONAL_ROUTE_GATE = /\bMap(?:Controller|AreaController|Http)?Route\b|\bMapDefaultControllerRoute\b|\bUseMvcWithDefaultRoute\b/;

const DEFAULT_PATTERN = "{controller=Home}/{action=Index}/{id?}";

/** Positional index of the template, and of the defaults object, per registration method. */
const REGISTRATIONS: Record<string, { template: number; defaults: number; named: string[]; area?: number; webApi?: boolean }> = {
  MapControllerRoute: { template: 1, defaults: 2, named: ["pattern"] },
  MapAreaControllerRoute: { template: 2, defaults: 3, named: ["pattern"], area: 1 },
  MapRoute: { template: 1, defaults: 2, named: ["url", "template"] },
  MapHttpRoute: { template: 1, defaults: 2, named: ["routeTemplate"], webApi: true },
};

export function extractConventionalPatterns(root: Node, sourceText: string, facts: RouteFact[]): void {
  if (!CONVENTIONAL_ROUTE_GATE.test(sourceText)) return;
  const walk = (n: Node): void => {
    if (n.type === "invocation_expression") {
      const fact = registration(n);
      if (fact) facts.push({ kind: CS_CONVENTIONAL_ROUTE_FACT, line: n.startPosition.row + 1, data: fact });
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
}

function registration(call: Node): CsConventionalPattern | null {
  const fn = call.childForFieldName("function");
  const name = fn?.type === "member_access_expression" ? fn.childForFieldName("name")?.text : fn?.text;
  if (!name) return null;
  if (name === "MapDefaultControllerRoute" || name === "UseMvcWithDefaultRoute") {
    return { pattern: DEFAULT_PATTERN, optional: [] };
  }
  const spec = REGISTRATIONS[name];
  if (!spec) return null;
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type === "argument");
  const positional: Node[] = [];
  const named = new Map<string, Node>();
  for (const a of args) {
    const value = a.namedChildren[a.namedChildren.length - 1];
    if (!value) continue;
    const label = a.children[1]?.type === ":" ? a.children[0]?.text : undefined;
    if (label) named.set(label, value);
    else positional.push(value);
  }
  const templateNode = spec.named.map((k) => named.get(k)).find(Boolean) ?? positional[spec.template];
  const pattern = templateNode ? stringValue(templateNode) : null;
  if (pattern === null) return null;
  const out: CsConventionalPattern = { pattern: pattern.replace(/^~?\//, ""), optional: [] };
  const defaults = named.get("defaults") ?? positional[spec.defaults];
  if (defaults?.type === "anonymous_object_creation_expression") {
    // `new { controller = "Home", id = UrlParameter.Optional }`: any default makes it optional.
    const kids = defaults.children;
    for (let i = 0; i + 1 < kids.length; i++) {
      if (kids[i]!.type === "identifier" && kids[i + 1]!.type === "=") out.optional.push(kids[i]!.text);
    }
  }
  if (spec.area !== undefined) {
    const areaNode = named.get("areaName") ?? positional[spec.area];
    const area = areaNode ? stringValue(areaNode) : null;
    if (area) out.area = area;
  }
  if (spec.webApi) out.webApi = true;
  return out;
}

function stringValue(n: Node): string | null {
  if (n.type !== "string_literal" && n.type !== "verbatim_string_literal") return null;
  const content = n.namedChildren.find((c) => c.type === "string_literal_content");
  return content ? content.text : n.text.replace(/^@?"/, "").replace(/"$/, "");
}

/**
 * The path one action is served at under a conventional pattern: `{controller}`,
 * `{action}` and `{area}` filled in, a required parameter kept as `{name}`, an
 * optional one kept only when the action takes a parameter of that name (the
 * URL a view links to then carries it). Null when the pattern cannot serve
 * this action generally — no `{controller}`, an MVC pattern with no
 * `{action}` (a route dedicated to one action), an `{area}` with no area.
 */
export function conventionalPath(
  p: CsConventionalPattern,
  controller: string,
  action: string | null,
  area: string | null,
  paramNames: readonly string[],
): string | null {
  const tokens = [...p.pattern.matchAll(/\{([^}]*)\}/g)].map((m) => tokenName(m[1]!));
  if (!tokens.includes("controller")) return null;
  if (!p.webApi && !tokens.includes("action")) return null;
  const takes = new Set(paramNames.map((n) => n.toLowerCase()));
  const optional = new Set(p.optional.map((n) => n.toLowerCase()));
  const segs: string[] = [];
  for (const seg of p.pattern.split("/")) {
    let dropped = false;
    let failed = false;
    const out = seg.replace(/\{([^}]*)\}/g, (_m, inner: string) => {
      const name = tokenName(inner);
      const key = name.toLowerCase();
      if (key === "controller") return controller;
      if (key === "action") {
        if (action === null) failed = true;
        return action ?? "";
      }
      if (key === "area") {
        if (!area) failed = true;
        return area ?? "";
      }
      const isOptional = /[?=]/.test(inner) || inner.startsWith("*") || optional.has(key);
      if (isOptional && !takes.has(key)) {
        dropped = true;
        return "";
      }
      return `{${name}}`;
    });
    if (failed) return null;
    if (dropped && out.replace(/[^A-Za-z0-9{}]/g, "") === "") continue;
    if (out) segs.push(out);
  }
  return "/" + segs.join("/");
}

/** `controller=Home` / `id?` / `id:int` / `*slug` → the parameter's name. */
function tokenName(inner: string): string {
  return inner.replace(/^\*{1,2}/, "").replace(/[:=?].*$/, "").trim();
}

/** `Areas/Admin/Controllers/X.cs` → `Admin`: where MVC 5 areas keep their controllers and registrations. */
export function areaOfPath(filePath: string): string | null {
  return /(?:^|\/)Areas\/([^/]+)\//.exec(filePath)?.[1] ?? null;
}

/** Web API 2 picks an action by the verb its name starts with; any other name answers POST. */
export function webApiVerb(method: string): string {
  const m = /^(Get|Post|Put|Delete|Patch|Head|Options)/.exec(method);
  return m ? m[1]!.toUpperCase() : "POST";
}
