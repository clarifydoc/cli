import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";
import type { RouteInfo } from "../../../../types/analysis.js";

async function routesOf(src: string): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "typescript", "start/routes.ts");
  return javascriptRouteExtractor.extractRoutes(tree, src, "start/routes.ts");
}
const rows = (routes: RouteInfo[]) => routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler ?? "-"}${r.auth?.policies?.length ? ` [${r.auth.policies.join("+")}]` : ""}`);
const head = "import router from '@adonisjs/core/services/router'\nimport { middleware } from '#start/kernel'\nconst ClubsController = () => import('#controllers/clubs_controller')\n";

describe("AdonisJS routes", () => {
  it("reads a controller action as a tuple or a string naming the controller", async () => {
    const routes = await routesOf(`${head}
router.get('/clubs', [ClubsController, 'index'])
router.get('/clubs/:id', '#controllers/clubs_controller.show')
router.post('/players', 'PlayersController.store')
router.get('/ping', async () => 'pong')`);
    expect(rows(routes)).toEqual(["GET /clubs ClubsController.index", "GET /clubs/:id ClubsController.show", "POST /players PlayersController.store", "GET /ping -"]);
  });

  it("puts a group's prefix and guards on the routes inside, inner groups first", async () => {
    const routes = await routesOf(`${head}
router.group(() => {
  router.delete('/clubs/:id', [ClubsController, 'destroy'])
  router.group(() => {
    router.get('/stats', [ClubsController, 'stats'])
  }).prefix('/reports')
}).prefix('/admin').use(middleware.auth())
router.get('/open', [ClubsController, 'open'])`);
    expect(rows(routes)).toEqual([
      "DELETE /admin/clubs/:id ClubsController.destroy [middleware.auth]",
      "GET /admin/reports/stats ClubsController.stats [middleware.auth]",
      "GET /open ClubsController.open",
    ]);
  });

  it("expands a resource, as apiOnly, only or except, nested ones under the parent's id", async () => {
    const routes = await routesOf(`${head}
router.resource('clubs', ClubsController).apiOnly()
router.resource('players', PlayersController).only(['index', 'show'])
router.resource('clubs.fixtures', FixturesController).except(['create', 'edit', 'update', 'destroy', 'show'])`);
    expect(rows(routes)).toEqual([
      "GET /clubs ClubsController.index",
      "POST /clubs ClubsController.store",
      "GET /clubs/:id ClubsController.show",
      "PUT /clubs/:id ClubsController.update",
      "PATCH /clubs/:id ClubsController.update",
      "DELETE /clubs/:id ClubsController.destroy",
      "GET /players PlayersController.index",
      "GET /players/:id PlayersController.show",
      "GET /clubs/:club_id/fixtures FixturesController.index",
      "POST /clubs/:club_id/fixtures FixturesController.store",
    ]);
  });

  it("guards a single route by its own .use()", async () => {
    const routes = await routesOf(`${head}
router.post('/clubs', [ClubsController, 'store']).use(middleware.auth())
router.get('/clubs', [ClubsController, 'index'])`);
    expect(rows(routes)).toEqual(["POST /clubs ClubsController.store [middleware.auth]", "GET /clubs ClubsController.index"]);
  });

  it("leaves a client's call alone", async () => {
    expect(rows(await routesOf("const r = await axios.get('/clubs', ['a', 'b'])"))).toEqual([]);
    expect(rows(await routesOf("const r = await api.get('/clubs/export', 'blob')"))).toEqual([]);
  });

  it("types a parameter by its .where() matcher and keeps the path", async () => {
    const routes = await routesOf(`${head}
router.get('/clubs/:id', [ClubsController, 'show']).where('id', router.matchers.number())
router.get('/cars/:code', [CarsController, 'show']).where('code', /^[0-9]+$/)
router.get('/players/:slug', [PlayersController, 'show']).where('slug', router.matchers.slug())`);
    expect(routes.map((r) => `${r.path} ${r.params?.map((p) => `${p.name}:${p.type}`).join()}`)).toEqual(["/clubs/:id id:number", "/cars/:code code:number", "/players/:slug slug:slug"]);
  });
});

