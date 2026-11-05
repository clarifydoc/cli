import path from "node:path/posix";
import type { FileAnalysis } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";

/**
 * Laravel 11's `bootstrap/app.php`: `->withRouting(api: __DIR__.'/../routes/api.php', apiPrefix: 'v1/api')`
 * names the file served as the API and the prefix it is served under (default `api`).
 * The routes extractor prefixes `routes/api.php` with the default, so this pass,
 * from the bootstrap file's fact, swaps that leading segment for the configured one.
 */
export const LARAVEL_ROUTING_FACT = "php:laravel-routing";

export interface LaravelRoutingFact {
  /** The API routes file as written, relative to the bootstrap file's directory (`../routes/api.php`). */
  apiFile: string | null;
  apiPrefix: string;
}

/** `withRouting(api: …, apiPrefix: '…')`: the API file and the prefix (default `api`); null when it states neither. */
export function laravelRoutingFact(source: string): LaravelRoutingFact | null {
  const start = source.indexOf("withRouting(");
  if (start < 0) return null;
  const prefix = /\bapiPrefix\s*:\s*(['"])([^'"]*)\1/.exec(source.slice(start));
  const file = /\bapi\s*:\s*__DIR__\s*\.\s*(['"])([^'"]+)\1/.exec(source.slice(start));
  if (!prefix && !file) return null;
  // No `apiPrefix` is Laravel's default, `api`: it matters for an API file the extractor does not know by name.
  return { apiFile: file ? file[2]!.replace(/^\//, "") : null, apiPrefix: prefix ? prefix[2]!.replace(/^\/+|\/+$/g, "") : "api" };
}

export const laravelRoutingResolver: RouteResolver = {
  id: "laravel-routing",
  languages: ["php"],
  priority: 40,
  resolve(analyses: FileAnalysis[]): void {
    for (const bootstrap of analyses) {
      const fact = bootstrap.routeFacts?.find((f) => f.kind === LARAVEL_ROUTING_FACT)?.data as LaravelRoutingFact | undefined;
      if (!fact) continue;
      const apiFile = path.normalize(path.join(path.dirname(bootstrap.filePath), fact.apiFile ?? "../routes/api.php"));
      for (const a of analyses) {
        if (a.filePath !== apiFile) continue;
        // `routes/api.php` has the default prefix baked in by the extractor; any other file named as the API has none.
        const baked = /(^|\/)routes\/api\.php$/i.test(a.filePath);
        a.routes = a.routes.map((r) => {
          if (r.kind !== "api") return r;
          if (!baked) {
            const joined = `/${fact.apiPrefix}/${r.path}`.replace(/\/{2,}/g, "/");
            return { ...r, path: joined.length > 1 ? joined.replace(/\/$/, "") : "/" };
          }
          if (!/^\/api(?:\/|$)/.test(r.path)) return r;
          const rest = r.path.slice("/api".length);
          const joined = `/${fact.apiPrefix}${rest}`.replace(/\/{2,}/g, "/");
          return { ...r, path: joined.length > 1 ? joined.replace(/\/$/, "") : "/" };
        });
      }
    }
  },
};
