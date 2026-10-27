import type { RouteAuthInfo, RouteFilter, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../types/analysis.js";

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

/**
 * What kind of filter a name or attribute is, by the words it is spelled
 * with — across frameworks: `EnableRateLimiting`, `throttle:60,1`,
 * `rateLimit()`, `@Throttle` → rate-limit; `EnableCors`, `cors()` → cors;
 * `ValidateAntiForgeryToken`, `csrf`, `VerifyCsrfToken` → csrf; `UsePipes(ValidationPipe)`,
 * `validate(schema)`, `celebrate` → validation; `ResponseCache`, `OutputCache`,
 * `CacheInterceptor` → cache; `Transactional`, `UnitOfWork` → transaction;
 * `LoggingInterceptor`, `morgan` → logging; `UseFilters(HttpExceptionFilter)` → error.
 * Null for a name that says nothing (the plugin knows auth separately).
 */
export function filterKind(text: string): RouteFilter["kind"] | null {
  const t = text.replace(/[\s_-]+/g, "").toLowerCase();
  if (/ratelimit|throttl|slowdown|bucket4j|resilience4j\.ratelimiter/.test(t)) return "rate-limit";
  if (/cors/.test(t)) return "cors";
  if (/antiforgery|csrf|xsrf|csurf|lusca/.test(t)) return "csrf";
  if (/valid|celebrate|zvalidator|pipe\(|usepipes/.test(t)) return "validation";
  if (/cache|etag/.test(t)) return "cache";
  if (/transaction|unitofwork|atomic/.test(t)) return "transaction";
  if (/morgan|logging|logger|audit|requestlog|tracing/.test(t)) return "logging";
  if (/exceptionfilter|errorhandler|usefilters|catch\(/.test(t)) return "error";
  return null;
}

/** A filter attribute that switches its protection off: `DisableRateLimiting`, `IgnoreAntiforgeryToken`, `SkipThrottle`, `DisableCors`. */
export function disablesFilter(text: string): boolean {
  return /^\s*(?:Disable|Ignore|Skip|Without)/i.test(text);
}

/** Filters as written → `RouteFilter`s; names that classify as nothing are dropped. */
export function routeFilters(texts: readonly string[], inherited: boolean): RouteFilter[] {
  const out: RouteFilter[] = [];
  for (const text of texts) {
    const kind = filterKind(text);
    if (!kind) continue;
    out.push({ text, kind, ...(inherited ? { inherited: true } : {}), ...(disablesFilter(text) ? { enabled: false as const } : {}) });
  }
  return out;
}

export interface RouteMeta {
  /** Guards from the enclosing class / router / group, applied to every action. */
  inheritedGuards?: readonly GuardAttr[];
  /** Guards on the action itself. */
  guards?: readonly GuardAttr[];
  /** Non-auth filters as written (`EnableRateLimiting("fixed")`, `UsePipes(ValidationPipe)`), from the class / router. */
  inheritedFilters?: readonly string[];
  /** …and on the action itself. */
  filters?: readonly string[];
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
  // A framework that lists every middleware as a guard (Laravel `throttle:60,1`) has its filters among them.
  const filters = [
    ...routeFilters([...(meta.inheritedFilters ?? []), ...inherited.map((g) => g.text)], true),
    ...routeFilters([...(meta.filters ?? []), ...own.map((g) => g.text)], false),
  ];
  if (filters.length > 0) route.filters = [...(route.filters ?? []), ...filters];
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

/**
 * A copy of `route` that also requires `guards`, declared around it rather than
 * on it (a router class, a base controller): their texts lead its middleware
 * (each once), their requirements join its auth, and its own `inherited` and
 * `anonymous` stand.
 */
export function withInheritedGuards(route: RouteInfo, guards: readonly GuardAttr[]): RouteInfo {
  const texts = [...new Set(guards.map((g) => g.text))].filter((t) => !route.middleware.includes(t));
  const added = buildAuth(guards, [])!;
  const own = route.auth;
  const uniq = (xs: string[]) => [...new Set(xs)];
  const auth: RouteAuthInfo = own
    ? {
        policies: uniq([...added.policies, ...own.policies]),
        roles: uniq([...added.roles, ...own.roles]),
        schemes: uniq([...added.schemes, ...own.schemes]),
        anonymous: own.anonymous || added.anonymous,
        inherited: own.inherited,
      }
    : added;
  return { ...route, middleware: [...texts, ...route.middleware], auth };
}
