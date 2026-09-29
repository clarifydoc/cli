import type { RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import { applyRouteMeta, inferredParam } from "../../shared/route-metadata.js";
import { splitTopLevel } from "../shared/regex-base.js";

/**
 * Play's `conf/routes` file — the one place a Play application declares its
 * endpoints:
 *
 *   GET     /orders/:id          controllers.OrderController.show(id: Long)
 *   GET     /orders              controllers.OrderController.list(page: Int ?= 1)
 *   POST    /orders              controllers.OrderController.create()
 *   GET     /files/*path         controllers.Assets.at(path: String)
 *   GET     /items/$id<[0-9]+>   controllers.Items.get(id: Long)
 *   ->      /api                 api.Routes
 *
 * The handler is `Class.method` with the package dropped, which is what the
 * project-level join resolves against the controller's methods. A parameter
 * binds from the path when the template names it and from the query string
 * otherwise — Play's own rule, so both are marked inferred. `*path` and
 * `$id<regex>` become `:path` / `:id`, the linker's wildcard form.
 *
 * Nothing about auth is visible here: a Play action's guard is the
 * `Action` builder the controller method uses, not a routes-file attribute.
 *
 * NOTE: this file has no extension, so it is only reached if file discovery
 * learns to claim named files — see the plugin's `extractRoutes` dispatch.
 */

const ROUTE_LINE_RE = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(\S+?)(?:\s*\((.*)\))?\s*$/;

/** `conf/routes`, `routes`, `api.routes` — Play's routes files. */
export function isPlayRoutesFile(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? "";
  return base === "routes" || base.endsWith(".routes");
}

function normalizePath(path: string): string {
  return path
    .replace(/\*([A-Za-z_]\w*)/g, ":$1")
    .replace(/\$([A-Za-z_]\w*)<[^>]*>/g, ":$1");
}

/** `controllers.OrderController.show` → `OrderController.show`; `@controllers.X.y` too. */
function handlerName(raw: string): string {
  const parts = raw.replace(/^@/, "").split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : raw;
}

function parseParams(text: string | undefined, path: string): RouteParamInfo[] {
  if (!text || !text.trim()) return [];
  const out: RouteParamInfo[] = [];
  for (const piece of splitTopLevel(text)) {
    // `name: Type`, `name: Type ?= default`, `name: Type = fixed`, bare `name`.
    const m = piece.trim().match(/^([A-Za-z_]\w*)\s*(?::\s*([^=?]+?))?\s*(?:(?:\?=|=).*)?$/);
    if (!m) continue;
    out.push(inferredParam(m[1]!, m[2]?.trim() ?? null, path, "query"));
  }
  return out;
}

export function extractPlayRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:#|\+|->)/.test(line)) continue; // comment, modifier (`+ nocsrf`), sub-router include
    const m = line.match(ROUTE_LINE_RE);
    if (!m) continue;
    const path = normalizePath(m[2]!);
    const route: RouteInfo = {
      path,
      httpMethod: m[1]!,
      kind: "api",
      handler: handlerName(m[3]!),
      calls: [],
      middleware: [],
      line: i + 1,
    };
    applyRouteMeta(route, { params: parseParams(m[4], path) });
    routes.push(route);
  }
  return routes;
}
