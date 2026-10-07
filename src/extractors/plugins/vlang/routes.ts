import type { ClassInfo, RouteInfo } from "../../../types/analysis.js";

/**
 * veb / vweb routes. An app struct's method is an endpoint when it returns
 * `veb.Result` / `vweb.Result` or carries a route attribute:
 *
 *     @['/users/:id'; get; post]
 *     pub fn (mut app App) user(mut ctx Context, id string) veb.Result {
 *
 * The attribute names the path (`'/users/:id'`) and the methods (`get`,
 * `post`, … — GET when none); without a path the route is the method's name
 * (`/about`), `index` being `/`. The older `['/x'; post]` form without `@`
 * reads the same. A request `Context`'s own Result-returning methods are
 * response helpers, not endpoints. Paths keep the framework's `:name`
 * placeholders, and the handler is `App.method`.
 */
export function extractVRoutes(lines: string[], classes: ClassInfo[]): RouteInfo[] {
  if (!lines.some((l) => /\b(?:v?web|veb)\b/.test(l))) return [];
  const routes: RouteInfo[] = [];
  for (const cls of classes) {
    for (const m of cls.methods) {
      const attrs = m.decorators.flatMap((d) => d.split(";").map((t) => t.trim()).filter(Boolean));
      const path = attrs.map((t) => /^(['"])(\/[^'"]*)\1$/.exec(t)?.[2]).find((p) => p !== undefined);
      const verbs = attrs.filter((t) => /^(?:get|post|put|patch|delete|head|options)$/i.test(t)).map((t) => t.toUpperCase());
      // A `Context`'s Result-returning methods are response helpers
      // (`ctx.not_found()`): routes only when an attribute says so.
      const isResult = /\b(?:v?web|veb)\.Result\b/.test(m.returnType ?? "") && !/Context$/.test(cls.name);
      if (!isResult && path === undefined && verbs.length === 0) continue;
      for (const method of verbs.length > 0 ? verbs : ["GET"]) {
        routes.push({
          path: path ?? (m.name === "index" ? "/" : `/${m.name}`),
          httpMethod: method,
          kind: "api",
          handler: `${cls.name}.${m.name}`,
          calls: [],
          middleware: attrs.filter((t) => /^middleware\s*:/.test(t)).map((t) => t.replace(/^middleware\s*:\s*/, "")),
          line: m.line,
        });
      }
    }
  }
  return routes.sort((a, b) => a.line - b.line);
}
