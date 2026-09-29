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

async function fullRoutesOf(src: string): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "routes.ts");
  const routes: RouteInfo[] = [];
  extractExpressRoutes(tree.rootNode, routes);
  return routes;
}

/**
 * Regression: with `router.get('/', requireAuth, async (req, res) => …)` the
 * guard became the `handler` and `middleware` stayed empty. The last argument
 * is the handler; everything before it is middleware.
 */
describe("Express routes — middleware, handler and auth", () => {
  it("keeps guards out of handler for an inline function and derives auth", async () => {
    const [r] = await fullRoutesOf(
      `router.get('/', requireAuth, authorize('admin'), passport.authenticate('jwt', { session: false }), validate(schema), async (req, res) => res.json([]));`,
    );
    expect(r!.handler).toBeNull();
    expect(r!.middleware).toEqual([
      "requireAuth",
      "authorize('admin')",
      "passport.authenticate('jwt', { session: false })",
      "validate(schema)",
    ]);
    expect(r!.auth).toEqual({
      policies: ["requireAuth"],
      roles: ["admin"],
      schemes: ["jwt"],
      anonymous: false,
      inherited: false,
    });
  });

  it("takes an identifier last argument as the handler with the rest as middleware", async () => {
    const [r] = await fullRoutesOf(`router.post('/users', auth.required, upload.single('avatar'), createUser);`);
    expect(r!.handler).toBe("createUser");
    expect(r!.middleware).toEqual(["auth.required", "upload.single('avatar')"]);
    expect(r!.auth?.policies).toEqual(["auth.required"]);
    // Declared elsewhere: params come from the project-level join, not here.
    expect(r!.params).toBeUndefined();
  });

  it("flattens a middleware array and leaves non-auth middleware out of auth", async () => {
    const [r] = await fullRoutesOf(`app.get('/x', [cors(), express.json()], handler);`);
    expect(r!.middleware).toEqual(["cors()", "express.json()"]);
    expect(r!.auth).toBeUndefined();
  });

  it("applies a router-level use(guard) declared earlier to later routes on that receiver only", async () => {
    const routes = await fullRoutesOf(
      `router.get('/before', (req, res) => {});
       router.use(express.json());
       router.use(ensureLoggedIn);
       app.use(cors());
       router.get('/after', (req, res) => {});
       router.post('/after', requireRole('editor'), (req, res) => {});
       app.get('/other', (req, res) => {});`,
    );
    const by = (m: string, p: string) => routes.find((r) => r.httpMethod === m && r.path === p)!;
    expect(by("GET", "/before").auth).toBeUndefined();
    expect(by("GET", "/after").middleware).toEqual(["ensureLoggedIn"]);
    expect(by("GET", "/after").auth).toEqual({
      policies: ["ensureLoggedIn"], roles: [], schemes: [], anonymous: false, inherited: true,
    });
    expect(by("POST", "/after").middleware).toEqual(["ensureLoggedIn", "requireRole('editor')"]);
    expect(by("POST", "/after").auth?.roles).toEqual(["editor"]);
    expect(by("POST", "/after").auth?.inherited).toBe(false);
    expect(by("GET", "/other").auth).toBeUndefined();
  });
});

describe("Express routes — inline handler params", () => {
  it("reads path tokens and request accesses from the handler body", async () => {
    const [r] = await fullRoutesOf(
      `router.put('/users/:id/posts/:postId', upload.single('cover'), async (req: AuthRequest, res: Response) => {
         const { title, tags = [] } = req.body;
         const page = req.query.page;
         const token = req.headers.authorization;
         const key = req.get('x-api-key');
         await update(Number(req.params.id), req.body);
         if (req.file) {}
       });`,
    );
    expect(r!.params).toEqual([
      { name: "id", type: null, binding: "route", inferred: true },
      { name: "postid", type: null, binding: "route", inferred: true },
      { name: "title", type: null, binding: "body", inferred: true },
      { name: "tags", type: null, binding: "body", inferred: true },
      { name: "page", type: null, binding: "query", inferred: true },
      { name: "authorization", type: null, binding: "header", inferred: true },
      { name: "x-api-key", type: null, binding: "header", inferred: true },
      { name: "body", type: null, binding: "body", inferred: true },
      { name: "file", type: null, binding: "form", inferred: true },
      { name: "cover", type: null, binding: "form", inferred: true },
    ]);
  });

  it("follows Koa's ctx.request.body and ctx.params", async () => {
    const [r] = await fullRoutesOf(
      `router.post('/items/:id', async (ctx) => { const { name } = ctx.request.body; ctx.body = ctx.params.id + ctx.query.q; });`,
    );
    expect(r!.params).toEqual([
      { name: "id", type: null, binding: "route", inferred: true },
      { name: "name", type: null, binding: "body", inferred: true },
      { name: "q", type: null, binding: "query", inferred: true },
    ]);
  });

  it("omits params when the handler reads nothing and the path has no tokens", async () => {
    const [r] = await fullRoutesOf(`app.get('/health', (req, res) => res.json({ ok: true }));`);
    expect(r!.params).toBeUndefined();
  });
});
