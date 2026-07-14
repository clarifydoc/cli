import type { RouteInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * JSight API-description files (https://jsight.io) — a line-oriented spec
 * format used by contract-first services. Each endpoint opens with an
 * unindented `VERB /path` line:
 *
 *   GET /find-persons
 *     Query "search=xxx"
 *     200
 *       @PersonDataResponse
 *
 * Contract-first backends often implement interfaces from an external API
 * artifact, so their resource classes carry NO routing annotations — the spec
 * file is the only in-repo statement of the served API surface. Each endpoint
 * line becomes one `api` route (the indented Query/Request/response blocks
 * are schema detail, not routes).
 */

const ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)\s*$/;

export function extractJsightRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ENDPOINT_RE.exec(lines[i]!);
    if (!m) continue;
    routes.push({
      path: m[2]!,
      httpMethod: m[1]!,
      kind: "api",
      handler: null,
      calls: [],
      middleware: [],
      line: i + 1,
    });
  }
  return routes;
}

export const jsightSpec: RegexLangSpec = {
  language: "jsight",
  extensions: [".jsight"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  lineCommentPrefixes: ["//"],
  extractRoutes: (lines) => extractJsightRoutes(lines),
};
