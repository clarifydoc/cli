import type { ClassInfo, RouteInfo } from "../../../types/analysis.js";

/**
 * Apex REST resources: `@RestResource(urlMapping='/clubs/*')` on a class, and one of `@HttpGet`, `@HttpPost`,
 * `@HttpPut`, `@HttpPatch`, `@HttpDelete` on each method that serves a verb. Salesforce serves them under
 * `/services/apexrest`, so the route is that base joined to the mapping.
 *
 * A mapping's `*` matches any text: a whole `*` segment is spelled `{wildcard}` — the placeholder shape every route
 * plugin uses, so a caller's `/services/apexrest/clubs/001A` joins it — and a `*` inside a segment stays literal.
 * Apex's own namespaced form (`/services/apexrest/<namespace>/clubs`) is the organisation's, never the code's.
 */
export const APEX_REST_BASE = "/services/apexrest";

const VERBS = new Map([["httpget", "GET"], ["httppost", "POST"], ["httpput", "PUT"], ["httppatch", "PATCH"], ["httpdelete", "DELETE"]]);

/** The path a `urlMapping` serves. */
export function restPath(mapping: string): string {
  const segments = mapping.replace(/^\/+/, "").split("/").filter((s, i, all) => s !== "" || i === all.length - 1);
  return `${APEX_REST_BASE}/${segments.map((s) => (s === "*" ? "{wildcard}" : s)).join("/")}`.replace(/\/+$/, "") || APEX_REST_BASE;
}

export function extractApexRoutes(classes: readonly ClassInfo[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const cls of classes) {
    const resource = cls.decorators.find((d) => /^RestResource\b/i.test(d));
    if (!resource) continue;
    const mapping = /\burlMapping\s*=\s*'([^']*)'/i.exec(resource)?.[1];
    if (mapping === undefined) continue;
    for (const method of cls.methods) {
      for (const deco of method.decorators) {
        const verb = VERBS.get(/^(\w+)/.exec(deco)?.[1]?.toLowerCase() ?? "");
        if (!verb) continue;
        routes.push({
          path: restPath(mapping),
          httpMethod: verb,
          kind: "api",
          handler: `${cls.name}.${method.name}`,
          calls: [],
          middleware: [],
          line: method.line,
        });
      }
    }
  }
  return routes.sort((a, b) => a.line - b.line);
}
