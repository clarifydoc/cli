import type { RouteInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, findEndLine } from "../shared/regex-base.js";
import { RAKU_CALLS } from "./calls.js";

const VERB = /^\s*(get|post|put|patch|delete|head|options)\s+->\s*(.*?)\{/;
const HUMMING_BIRD = /^\s*(get|post|put|patch|delete|head|options)\(\s*['"]([^'"]+)['"]\s*,/;

/** Cro signature segments → a path: `'orders', Int $id, 'close'` → `/orders/{id}/close`. */
function croPath(signature: string): string {
  const segments: string[] = [];
  for (const raw of signature.split(",")) {
    const seg = raw.trim().replace(/\s+where\s+.*$/, "");
    if (!seg) continue;
    const literal = /^['"]([^'"]*)['"]$/.exec(seg) ?? /^<([^>]*)>$/.exec(seg);
    if (literal) { segments.push(...literal[1]!.split(/\s+/).filter(Boolean)); continue; }
    if (/^(?:[\w:]+\s+)?:[$@%]/.test(seg)) continue; // `Str :$q` — a query parameter, not a segment
    const slurpy = /^\*[@%]/.test(seg);
    const name = /[$@%](\w[\w'-]*)/.exec(seg)?.[1];
    if (name) segments.push(slurpy ? "*" : `{${name}}`);
  }
  return "/" + segments.join("/");
}

/** `include 'api' => api-routes()` / `include <api v1> => api-routes` → routine name → prefix. */
function includes(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const m = /^\s*include\s+(?:['"]([^'"]+)['"]|<([^>]+)>|(\w[\w-]*))\s*=>\s*([\w-]+)/.exec(line);
    if (m) out.set(m[4]!, "/" + (m[1] ?? m[2] ?? m[3]!).trim().split(/\s+/).join("/"));
  }
  return out;
}

/**
 * Raku web routes:
 *  - Cro: `get -> 'orders', Int $id { … }` inside a `route { … }` block — the
 *    signature IS the path (literal segments, `$captures`); a block in a
 *    routine another `include 'api' => api-routes()` mounts sits under its prefix;
 *  - Humming-Bird: `get('/orders/:id', -> $request, $response { … });`.
 * The block is the handler: its calls are the route's.
 */
export function extractRakuRoutes(lines: string[]): RouteInfo[] {
  if (!lines.some((l) => /\b(?:get|post|put|patch|delete)\b/.test(l))) return [];
  const prefixes = includes(lines);
  const routines: Array<{ name: string; start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:(?:my|our)\s+)?sub\s+([\w-]+)/.exec(lines[i]!);
    if (m && prefixes.has(m[1]!)) routines.push({ name: m[1]!, start: i, end: findEndLine(lines, i, "brace") });
  }
  const prefixAt = (i: number) => {
    const r = routines.find((x) => x.start < i && i < x.end);
    return r ? prefixes.get(r.name)! : "";
  };
  const routes: RouteInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cro = VERB.exec(line);
    const hb = cro ? null : HUMMING_BIRD.exec(line);
    if (!cro && !hb) continue;
    const end = findEndLine(lines, i, "brace");
    const path = cro ? croPath(cro[2]!) : hb![2]!.replace(/:(\w+)/g, "{$1}");
    const prefix = prefixAt(i);
    routes.push({
      path: prefix ? `${prefix}${path === "/" ? "" : path}` : path,
      httpMethod: (cro ?? hb)![1]!.toUpperCase(),
      kind: "api",
      handler: null,
      calls: extractCallsFromBody(lines, i + 1, end, ["#"], RAKU_CALLS, { line: i, column: line.indexOf("{") + 1 }),
      middleware: [],
      line: i + 1,
    });
  }
  return routes;
}
