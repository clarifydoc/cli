import type { RouteAuthInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../types/analysis.js";

/**
 * The attribute layer of a route, framework-agnostic. Every route extractor
 * that can see guards, API versions or parameter bindings reduces them to
 * these shapes and lets `applyRouteMeta` write the optional `RouteInfo`
 * fields — so ASP.NET `[Authorize(Policy = …)]`, Spring `@PreAuthorize`,
 * NestJS `@UseGuards` and a Laravel `->middleware('auth:sanctum')` all land
 * in the same `auth` a consumer reads once.
 */

/** One guard as declared: a readable string plus what it contributes. */
export interface GuardAttr {
  /** As the reader would recognise it: `Authorize(Policy = "X")`, `PreAuthorize("hasRole('ADMIN')")`, `auth:sanctum`. */
  text: string;
  /** `[AllowAnonymous]` / `@PermitAll` / `@Public()` — waives every other guard. */
  anonymous?: boolean;
  policies?: string[];
  roles?: string[];
  schemes?: string[];
}

/**
 * Merge class-level (inherited) and action-level guards the way every
 * annotation framework does: each guard adds a requirement, and an anonymous
 * marker anywhere waives them all. No guard at all → null, which means
 * "nothing declared here", not "open".
 */
export function buildAuth(inherited: readonly GuardAttr[], own: readonly GuardAttr[]): RouteAuthInfo | null {
  if (inherited.length === 0 && own.length === 0) return null;
  const all = [...inherited, ...own];
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    policies: uniq(all.flatMap((g) => g.policies ?? [])),
    roles: uniq(all.flatMap((g) => g.roles ?? [])),
    schemes: uniq(all.flatMap((g) => g.schemes ?? [])),
    anonymous: all.some((g) => g.anonymous === true),
    inherited: own.length === 0,
  };
}

/** `"Admin, Editor"` → `["Admin", "Editor"]`. */
export function splitList(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
}

/** Parameter names a path template declares, as written: `/users/{id}/posts/:postId/<int:pk>` → id, postId, pk. */
export function pathParamTokens(path: string): string[] {
  const names: string[] = [];
  for (const m of path.matchAll(/\{\*{0,2}([A-Za-z_][\w-]*)[^}]*\}/g)) names.push(m[1]!);
  // `:id` outside braces and brackets — inside them a colon starts a constraint (`{id:int}`, `<int:pk>`).
  for (const m of path.replace(/\{[^}]*\}|<[^>]*>/g, " ").matchAll(/:([A-Za-z_][\w]*)/g)) names.push(m[1]!);
  for (const m of path.matchAll(/<(?:[\w.]+:)?([A-Za-z_][\w]*)>/g)) names.push(m[1]!);
  return [...new Set(names)];
}

/** The same names lowercased, for case-insensitive matching against parameter names. */
export function pathParamNames(path: string): Set<string> {
  return new Set(pathParamTokens(path).map((n) => n.toLowerCase()));
}

export interface RouteMeta {
  /** Guards from the enclosing class / router / group, applied to every action. */
  inheritedGuards?: readonly GuardAttr[];
  /** Guards on the action itself. */
  guards?: readonly GuardAttr[];
  versions?: readonly string[];
  deprecatedVersions?: readonly string[];
  params?: readonly RouteParamInfo[];
}

/** Write the optional metadata fields onto a route; absent inputs leave the route untouched. */
export function applyRouteMeta(route: RouteInfo, meta: RouteMeta): RouteInfo {
  const inherited = meta.inheritedGuards ?? [];
  const own = meta.guards ?? [];
  if (inherited.length > 0 || own.length > 0) {
    route.middleware = [...route.middleware, ...inherited.map((g) => g.text), ...own.map((g) => g.text)];
    const auth = buildAuth(inherited, own);
    if (auth) route.auth = auth;
  }
  if (meta.versions && meta.versions.length > 0) {
    route.versions = [...meta.versions];
    if (meta.deprecatedVersions && meta.deprecatedVersions.length > 0) {
      route.deprecatedVersions = [...meta.deprecatedVersions];
    }
  }
  if (meta.params && meta.params.length > 0) route.params = [...meta.params];
  return route;
}

/** A parameter with an explicit binding. */
export function boundParam(name: string, type: string | null, binding: RouteParamBinding): RouteParamInfo {
  return { name, type, binding };
}

/**
 * A parameter the framework binds by its default rules: the path token rule
 * first (a name the template declares comes from the route), then whatever
 * the framework does with the rest (`fallback`), or null when nothing can be
 * said. Marked `inferred` so a reader can tell it from a declared binding.
 */
export function inferredParam(
  name: string,
  type: string | null,
  path: string,
  fallback: RouteParamBinding | null,
): RouteParamInfo {
  const binding = pathParamNames(path).has(name.toLowerCase()) ? "route" : fallback;
  return binding ? { name, type, binding, inferred: true } : { name, type, binding: null };
}
