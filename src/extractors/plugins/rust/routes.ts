import type { RouteInfo } from "../../../types/analysis.js";

/**
 * Rust server routes — the three dominant frameworks, none of which produced
 * any routes before:
 *
 *   - actix-web:  #[get("/users/{id}")] above `async fn get_user(...)`,
 *                 plus #[route("/x", method = "GET")]
 *   - Rocket:     #[get("/users/<id>")] — same attribute shape as actix;
 *                 `<param>` segments are rewritten to `{param}` so the
 *                 cross-tier normalizer treats them as route params
 *   - axum:       Router::new().route("/users", get(list).post(create)) —
 *                 one route per method-router verb on the line
 *
 * axum `.nest("/api", other_router)` prefixes require cross-variable router
 * resolution and are out of scope here (logged as a gap).
 */

/** `#[get("/path")]` / `#[rocket::get("/path?<q>")]` — actix & Rocket verb macros. */
const ATTR_VERB_RE = /^\s*#\[\s*(?:\w+::)*(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"/;
/** `#[route("/path", method = "GET", method = "POST")]` — actix multi-method. */
const ATTR_ROUTE_RE = /^\s*#\[\s*(?:\w+::)*route\s*\(\s*"([^"]+)"([^)]*)\)/;
const METHOD_ATTR_RE = /method\s*=\s*"(\w+)"/g;
/** `.route("/path", get(handler).post(handler2))` — axum method routers. */
const AXUM_ROUTE_RE = /\.\s*route\s*\(\s*"([^"]+)"\s*,(.*)$/;
const AXUM_VERB_RE = /\b(get|post|put|patch|delete|head|options)\s*\(\s*([\w:]+)?/g;

const FN_RE = /\bfn\s+(\w+)/;

/** Rocket `<id>` / `<id..>` path params → `{id}` (the normalizer's wildcard form). */
function normalizeParams(path: string): string {
  return path.replace(/<([^>]+?)(?:\.\.)?>/g, "{$1}");
}

/** The handler fn declared within a few lines below an attribute macro. */
function fnBelow(lines: string[], attrLine: number): string | null {
  for (let j = attrLine + 1; j < Math.min(attrLine + 7, lines.length); j++) {
    const l = lines[j]!;
    if (/^\s*#\[/.test(l) || /^\s*\/\//.test(l)) continue; // stacked attrs / comments
    const m = l.match(FN_RE);
    if (m) return m[1]!;
    if (l.trim() && !/^\s*(pub|async)\b/.test(l)) break; // something else — give up
  }
  return null;
}

export function extractRustRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const verbAttr = line.match(ATTR_VERB_RE);
    if (verbAttr) {
      routes.push({
        path: normalizeParams(verbAttr[2]!),
        httpMethod: verbAttr[1]!.toUpperCase(),
        kind: "api",
        handler: fnBelow(lines, i),
        calls: [],
        middleware: [],
        line: lineNo,
      });
      continue;
    }

    const routeAttr = line.match(ATTR_ROUTE_RE);
    if (routeAttr) {
      const methods = [...routeAttr[2]!.matchAll(METHOD_ATTR_RE)].map((m) => m[1]!.toUpperCase());
      const handler = fnBelow(lines, i);
      for (const m of methods.length > 0 ? methods : [null]) {
        routes.push({
          path: normalizeParams(routeAttr[1]!),
          httpMethod: m,
          kind: "api",
          handler,
          calls: [],
          middleware: [],
          line: lineNo,
        });
      }
      continue;
    }

    const axum = line.match(AXUM_ROUTE_RE);
    if (axum) {
      AXUM_VERB_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = AXUM_VERB_RE.exec(axum[2]!)) !== null) {
        routes.push({
          path: axum[1]!,
          httpMethod: m[1]!.toUpperCase(),
          kind: "api",
          handler: m[2] ? m[2].replace(/^:+/, "").split("::").pop()! : null,
          calls: [],
          middleware: [],
          line: lineNo,
        });
      }
    }
  }

  return routes;
}
