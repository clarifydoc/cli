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
 * axum `.nest("/api", user_routes())` composes when the nested router is
 * built by a SAME-FILE function: routes remember which `fn` they were declared
 * in, nest calls map that fn to a prefix (transitively — a nest inside a
 * nested fn chains), and prefixes are applied in a second pass. Cross-file
 * nesting stays out of scope.
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
/** Top-level fn declaration — marks route-ownership scope for nest resolution. */
const FN_DEF_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/;
/** `.nest("/api", user_routes())` / `.nest("/api", routes::users())`. */
const NEST_RE = /\.\s*nest\s*\(\s*"([^"]+)"\s*,\s*(?:\w+::)*(\w+)/;

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
  /** Owning fn per emitted axum route (parallel to `routes`; "" = top level). */
  const routeOwner: string[] = [];
  /** fn name → { prefix, owner } from the FIRST `.nest("/p", fn())` naming it. */
  const nests = new Map<string, { prefix: string; owner: string }>();
  let currentFn = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const fnDef = line.match(FN_DEF_RE);
    if (fnDef) currentFn = fnDef[1]!;

    const nest = line.match(NEST_RE);
    if (nest && !nests.has(nest[2]!)) {
      nests.set(nest[2]!, { prefix: nest[1]!, owner: currentFn });
    }

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
      routeOwner.push(currentFn);
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
        routeOwner.push(currentFn);
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
        routeOwner.push(currentFn);
      }
    }
  }

  // Apply nest prefixes: a route declared in fn F gets F's (transitive) nest
  // prefix — `.nest("/api", user_routes())` inside a fn that is itself nested
  // chains outward. Cycle-guarded; unnested fns resolve to "".
  const resolvePrefix = (fn: string, seen: Set<string>): string => {
    const n = nests.get(fn);
    if (!n || seen.has(fn)) return "";
    seen.add(fn);
    return resolvePrefix(n.owner, seen) + n.prefix;
  };
  for (let i = 0; i < routes.length; i++) {
    const prefix = resolvePrefix(routeOwner[i]!, new Set());
    if (prefix) {
      const joined = (prefix + routes[i]!.path).replace(/\/{2,}/g, "/").replace(/\/+$/, "");
      routes[i]!.path = joined || "/";
    }
  }

  return routes;
}
