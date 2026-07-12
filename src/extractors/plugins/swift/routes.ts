import type { RouteInfo } from "../../../types/analysis.js";

/**
 * Vapor (Swift server) routes — Swift produced zero routes before:
 *
 *   app.get("users", ":id") { req in ... }          // trailing-closure handler
 *   app.post("api", "orders", use: OrderController.create)
 *   let api = app.grouped("api")                    // group prefix binding
 *   api.get("todos", use: index)
 *   app.on(.GET, "custom") { ... }
 *
 * A path is spelled as comma-separated string segments (`"users", ":id"` →
 * `/users/:id` — `:param` is already the linker's wildcard form). Group vars
 * bound via `grouped(...)` carry a composed prefix, exactly like gin's Group.
 *
 * The verb names are generic (`.get(`), so a route requires the receiver to be
 * `app`/`routes`/`router`/`group` or a tracked `grouped(...)` variable —
 * `req.client.get("https://…")` (an OUTBOUND call) and dictionary helpers
 * never qualify.
 */

const GROUP_RE = /(?:let|var)\s+(\w+)\s*=\s*(\w+)\.grouped\s*\(([^)]*)\)/;
const VERB_RE = /\b(\w+)\.(get|post|put|patch|delete|head|options)\s*\(([^)]*)\)/;
const ON_RE = /\b(\w+)\.on\s*\(\s*\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*,?\s*([^)]*)\)/;
const USE_RE = /use:\s*([\w.]+)/;
const SEGMENT_RE = /"([^"]*)"/g;

/** Receivers that are route builders even without a tracked `grouped` binding. */
const BUILDER_RECEIVER_RE = /^(app|routes|router|group|builder)$/;

function segmentsOf(argText: string): string[] {
  return [...argText.matchAll(SEGMENT_RE)].map((m) => m[1]!).filter((s) => s.length > 0);
}

function joinPath(prefix: string, segments: string[]): string {
  const parts = [prefix, ...segments].join("/").split("/").filter(Boolean);
  return "/" + parts.join("/");
}

export function extractVaporRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  /** group variable → composed path prefix. */
  const varPrefix = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    const lineNo = i + 1;

    const group = line.match(GROUP_RE);
    if (group) {
      const base = varPrefix.get(group[2]!) ?? "";
      varPrefix.set(group[1]!, joinPath(base, segmentsOf(group[3]!)));
      continue;
    }

    const on = line.match(ON_RE);
    if (on && (varPrefix.has(on[1]!) || BUILDER_RECEIVER_RE.test(on[1]!))) {
      routes.push({
        path: joinPath(varPrefix.get(on[1]!) ?? "", segmentsOf(on[3]!)),
        httpMethod: on[2]!,
        kind: "api",
        handler: line.match(USE_RE)?.[1] ?? null,
        calls: [],
        middleware: [],
        line: lineNo,
      });
      continue;
    }

    const verb = line.match(VERB_RE);
    if (verb && (varPrefix.has(verb[1]!) || BUILDER_RECEIVER_RE.test(verb[1]!))) {
      const segments = segmentsOf(verb[3]!);
      const use = verb[3]!.match(USE_RE)?.[1] ?? null;
      // A verb with neither path segments nor a `use:` handler on a bare
      // builder name is likely not a route declaration at all.
      if (segments.length === 0 && !use && !varPrefix.has(verb[1]!)) continue;
      routes.push({
        path: joinPath(varPrefix.get(verb[1]!) ?? "", segments),
        httpMethod: verb[2]!.toUpperCase(),
        kind: "api",
        handler: use,
        calls: [],
        middleware: [],
        line: lineNo,
      });
    }
  }

  return routes;
}
