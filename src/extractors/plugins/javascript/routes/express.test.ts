import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { isRoutePath, extractExpressRoutes } from "./express.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * Guards the path-shape filter that stops `.get()`-shaped calls that aren't
 * routes from leaking into the inbound-routes table. Regression: a jQuery
 * plugin's `options.get('minSpotColor')` and Cypress `cy.get('button')` were
 * reported as `GET <string>` endpoints.
 */
describe("isRoutePath", () => {
  it.each(["/", "/users", "/users/:id", "/api/v1/orders", "*", "/*", "/users/${id}"])(
    "accepts route-shaped path %j",
    (p) => expect(isRoutePath(p)).toBe(true),
  );

  it.each([
    "minSpotColor", // jquery.sparkline options.get(...)
    "numberFormatter",
    "button", // Cypress cy.get(...)
    "input[name=user]",
    ".multiselect__tags",
    "etag", // res.get('etag')
    "content-type",
    "",
  ])("rejects non-route string %j", (p) => expect(isRoutePath(p)).toBe(false));
});

/**
 * Regression: a hand-written API client (`accountApiClient.get('/x', { params })`)
 * was extracted as an inbound API route — the receiver denylist can't enumerate
 * every client name (`accountApiClient`, `licenseApiClient`, …). Real routes
 * carry a handler; outbound client calls carry only a URL + optional config.
 */
async function routesOf(src: string): Promise<string[]> {
  const tree = await parseSource(src, "typescript" as any, "C.ts");
  const routes: RouteInfo[] = [];
  extractExpressRoutes(tree.rootNode, routes);
  return routes.map((r) => `${r.httpMethod} ${r.path}`);
}

describe("Express routes — handler gating", () => {
  it("does NOT treat an HTTP-client call as a route (no handler)", async () => {
    const routes = await routesOf(
      `const res = await accountApiClient.get('/access-report/roles/' + roleId + '/holders', { params: { page } });
       await accountApiClient.post('/access-report/permission-set/holders', body);
       await apiClient.delete(\`/owners/\${id}\`);`,
    );
    expect(routes).toEqual([]);
  });

  it("still extracts real Express routes (function and identifier handlers)", async () => {
    const routes = await routesOf(
      `app.get('/users', (req, res) => res.json([]));
       router.post('/users', createUser);
       app.get('/users/:id', auth, getUser);`,
    );
    expect(routes).toContain("GET /users");
    expect(routes).toContain("POST /users");
    expect(routes).toContain("GET /users/:id");
    expect(routes).toHaveLength(3);
  });
});
