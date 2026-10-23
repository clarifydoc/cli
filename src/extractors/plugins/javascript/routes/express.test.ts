import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { isRoutePath, extractExpressRoutes, regexRoutePaths } from "./express.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * Guards the path-shape filter that stops `.get()`-shaped calls that aren't
 * routes from leaking into the inbound-routes table. Regression: a jQuery
 * plugin's `options.get('minSpotColor')` and Cypress `cy.get('button')` were
 * reported as `GET <string>` endpoints.
 */
describe("isRoutePath", () => {
  it.each(["/", "/players", "/players/:id", "/api/v1/cars", "*", "/*", "/players/${id}"])(
    "accepts route-shaped path %j",
    (p) => expect(isRoutePath(p)).toBe(true),
  );

  it.each([
    "minSpotColor", // jquery.sparkline options.get(...)
    "numberFormatter",
    "button", // Cypress cy.get(...)
    "input[name=player]",
    ".multiselect__tags",
    "etag", // res.get('etag')
    "content-type",
    "",
  ])("rejects non-route string %j", (p) => expect(isRoutePath(p)).toBe(false));
});

/**
 * Regression: a hand-written API client (`clubApiClient.get('/x', { params })`)
 * was extracted as an inbound API route — the receiver denylist can't enumerate
 * every client name (`clubApiClient`, `licenseApiClient`, …). Real routes
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
      `const res = await clubApiClient.get('/access-report/roles/' + roleId + '/holders', { params: { page } });
       await clubApiClient.post('/access-report/permission-set/holders', body);
       await apiClient.delete(\`/owners/\${id}\`);`,
    );
    expect(routes).toEqual([]);
  });

  it("still extracts real Express routes (function and identifier handlers)", async () => {
    const routes = await routesOf(
      `app.get('/players', (req, res) => res.json([]));
       router.post('/players', createPlayer);
       app.get('/players/:id', auth, getPlayer);`,
    );
    expect(routes).toContain("GET /players");
    expect(routes).toContain("POST /players");
    expect(routes).toContain("GET /players/:id");
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
    const [r] = await fullRoutesOf(`router.post('/players', auth.required, upload.single('avatar'), createPlayer);`);
    expect(r!.handler).toBe("createPlayer");
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
      `router.put('/players/:id/games/:gameId', upload.single('cover'), async (req: AuthRequest, res: Response) => {
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
      { name: "gameid", type: null, binding: "route", inferred: true },
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

describe("Express routes — wrapped handlers", () => {
  it("reads the function an async/error adapter wraps", async () => {
    const routes = await fullRoutesOf(`
      app.get('/a', asyncHandler(async (req, res) => { res.json(await svc.list()); }));
      app.post('/b', requireAuth, catchAsync(createBall));
      app.get('/c', wrap(ctrl.show));
      app.get('/d', passport.authenticate('jwt'));`);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler ?? "<inline>"}`)).toEqual([
      "GET /a <inline>",
      "POST /b createBall",
      "GET /c ctrl.show",
    ]);
    expect(routes[0]!.calls.map((c) => c.name)).toContain("svc.list");
    expect(routes[1]!.middleware).toEqual(["requireAuth"]);
  });
});

describe("Express routes — routers mounted in their own file", () => {
  it("prefixes a local router's routes and drops the mount row", async () => {
    const routes = await fullRoutesOf(`
      const app = express();
      const api = express.Router();
      const admin = express.Router();
      api.get('/players', listPlayers);
      api.post('/players', createPlayer);
      admin.delete('/players/:id', removePlayer);
      api.use('/admin', requireAdmin, admin);
      app.use('/api', api);
      app.get('/health', (req, res) => res.send('ok'));`);
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`).sort()).toEqual([
      "DELETE /api/admin/players/:id",
      "GET /api/players",
      "GET /health",
      "POST /api/players",
    ]);
    const del = routes.find((r) => r.httpMethod === "DELETE")!;
    expect(del.middleware).toEqual(["requireAdmin"]);
    expect(del.auth?.inherited).toBe(true);
  });

  it("leaves a mount of an imported router for the project pass", async () => {
    const routes = await fullRoutesOf(`import players from './players'; app.use('/players', players); app.get('/x', h);`);
    expect(routes.filter((r) => r.mount).map((r) => r.path)).toEqual(["/players"]);
  });
});

describe("Express routes — a router that only mounts routers", () => {
  it("composes the whole chain", async () => {
    const routes = await fullRoutesOf(`
      const app = express(); const apiRouter = express.Router(); const playersRouter = express.Router();
      playersRouter.get('/:id', (req, res) => res.json({}));
      apiRouter.use('/players', playersRouter);
      app.use('/api/v1', apiRouter);`);
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /api/v1/players/:id"]);
  });
});

describe("Express routes — a client building a URL is no route", () => {
  it("refuses a path whose holes compute a value, keeps one mounted under a base constant", async () => {
    const out = await routesOf(`import * as api from '../../api'
const kit = () => api.get(\`/api/clubs/\${encodeURIComponent(club.slug)}/kits/\${kitMeta.id}\`, queryKey[1].state)
router.get(\`/\${SEASON}/clubs\`, listClubs)`);
    expect(out).toEqual(["GET /${SEASON}/clubs"]);
  });
});

describe("Express routes with a regex path", () => {
  it.each([
    ["^\\/clubs\\/([^/]+)\\/?$", ["/clubs/:param"]],
    ["^\\/(clubs|leagues)(\\/|$)", ["/clubs/*", "/leagues/*"]],
    ["^\\/api\\/([^/]+)\\/([^/]+)\\/?(squad)?$", ["/api/:param/:param/*"]],
    ["^\\/kits\\.json$", ["/kits.json"]],
    ["\\/clubs\\/\\d+", []],
    ["^.*$", []],
  ])("reads %s", (pattern, paths) => expect(regexRoutePaths(pattern)).toEqual(paths));

  it("registers each path of a regex route", async () => {
    const src = `app.get(/^\\/(clubs|leagues)(\\/|$)/, (req, res) => res.sendFile(indexHtml));\napp.use(/^\\/old/, legacy);`;
    const tree = await parseSource(src, "javascript" as never, "server.js");
    const routes: RouteInfo[] = [];
    extractExpressRoutes(tree.rootNode, routes);
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /clubs/*", "GET /leagues/*"]);
  });
});
