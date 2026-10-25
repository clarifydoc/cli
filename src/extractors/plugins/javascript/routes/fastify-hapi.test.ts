import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";
import { JavaScriptImportExportExtractor } from "../imports-exports.js";
import { resolveRouterMounts } from "../../../shared/router-mounts.js";
import { buildImportIndex } from "../../../../core/import-index.js";
import type { FileAnalysis, RouteInfo } from "../../../../types/analysis.js";

async function routesOf(src: string, file = "server.js"): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "javascript", file);
  return javascriptRouteExtractor.extractRoutes(tree, src, file);
}
const rows = (routes: RouteInfo[]) => routes.map((r) => `${r.mount ? "MOUNT" : r.httpMethod} ${r.path}`);

describe("Fastify", () => {
  it("serves an inline plugin's routes under its prefix, nested plugins composing", async () => {
    const routes = await routesOf(`
      fastify.register(async function (instance) {
        instance.get('/players', async (request, reply) => []);
        instance.register(async (inner) => {
          inner.post('/transfers', async () => ({}));
        }, { prefix: '/market' });
      }, { prefix: '/v2' });
      fastify.get('/health', async () => ({}));
    `);
    expect(rows(routes)).toEqual(["GET /v2/players", "POST /v2/market/transfers", "GET /health"]);
  });

  it("reads fastify.route({ method, url, handler }) with its preHandler guard, one row per method", async () => {
    const routes = await routesOf(`
      fastify.route({ method: ['PUT', 'PATCH'], url: '/matches/:id', preHandler: [fastify.authenticate], handler: updateMatch });
      fastify.route({ method: 'GET', url: '/clubs', handler: async (request, reply) => reply.send([]) });
    `);
    expect(rows(routes)).toEqual(["PUT /matches/:id", "PATCH /matches/:id", "GET /clubs"]);
    expect(routes[0]!.handler).toBe("updateMatch");
    expect(routes[0]!.auth?.policies).toEqual(["fastify.authenticate"]);
  });

  it("serves a plugin function the file declares under the prefix it is registered with", async () => {
    const routes = await routesOf(`
      async function clubRoutes(app) {
        app.get('/', async () => []);
      }
      fastify.register(clubRoutes, { prefix: '/api/clubs' });
    `);
    expect(rows(routes)).toEqual(["GET /api/clubs"]);
  });

  it("mounts an imported or in-place required plugin for the project mount pass", async () => {
    const routes = await routesOf(`
      const leagues = require('./leagues');
      fastify.register(leagues, { prefix: '/api/leagues' });
      fastify.register(require('./routes/clubs'), { prefix: '/api/clubs' });
      fastify.register(require('@fastify/cors'));
    `);
    expect(routes.map((r) => [r.path, r.handler, r.mountModule ?? null])).toEqual([
      ["/api/leagues", "leagues", null],
      ["/api/clubs", "require('./routes/clubs')", "./routes/clubs"],
    ]);
  });

  it("never reads an HTTP client's request options as a route", async () => {
    expect(await routesOf(`client.route({ method: 'GET', url: '/clubs', handler: h });`)).toEqual([]);
    expect(await routesOf(`router.route('/clubs').get(list);`)).toEqual([]);
  });
});

describe("hapi", () => {
  it("reads server.route objects and arrays, with auth and the any-method wildcard", async () => {
    const routes = await routesOf(`
      server.route({ method: 'GET', path: '/clubs/{id}', handler: (request, h) => ({ id: request.params.id }) });
      server.route([
        { method: 'POST', path: '/clubs', handler: createClub, options: { auth: 'jwt' } },
        { method: '*', path: '/{any*}', handler: notFound },
        { method: 'GET', path: '/status', options: { auth: false, handler: status } },
      ]);
    `);
    expect(rows(routes)).toEqual(["GET /clubs/{id}", "POST /clubs", "ALL /{any*}", "GET /status"]);
    expect(routes[1]!.auth?.schemes).toEqual(["jwt"]);
    expect(routes[3]!.auth?.anonymous).toBe(true);
    expect(routes[3]!.handler).toBe("status");
  });

  it("mounts a plugin registered with a routes prefix, in both register forms", async () => {
    const routes = await routesOf(`
      await server.register(require('./players'), { routes: { prefix: '/api' } });
      await server.register({ plugin: require('./matches'), routes: { prefix: '/league' } });
    `);
    expect(routes.map((r) => [r.mount, r.path, r.mountModule])).toEqual([
      [true, "/api", "./players"],
      [true, "/league", "./matches"],
    ]);
  });
});

describe("Koa", () => {
  it("serves a router's routes under its constructor or prefix() prefix, and mounts by routes()", async () => {
    const routes = await routesOf(`
      const router = new Router({ prefix: '/garages' });
      router.get('/', list);
      router.get('/:id', show);
      const cars = new Router();
      cars.prefix('/cars');
      cars.get('/', listCars);
      const api = new Router();
      api.use('/v1', router.routes());
      app.use(api.routes());
    `);
    expect(rows(routes).sort()).toEqual(["GET /cars", "GET /v1/garages", "GET /v1/garages/:id"]);
  });
});

describe("plugins and routers loaded where they are mounted", () => {
  it("resolves register(require('./x'), { prefix }) and app.use('/p', require('./x')) across files", async () => {
    const files: Record<string, string> = {
      "src/server.js": `
        fastify.register(require('./routes/clubs'), { prefix: '/api/clubs' });
        app.use('/admin', require('./routes/admin'));
      `,
      "src/routes/clubs.js": `module.exports = async function (fastify) { fastify.get('/:id', async () => ({})); };`,
      "src/routes/admin.js": `const router = express.Router(); router.get('/users', listUsers); module.exports = router;`,
    };
    const imports = new JavaScriptImportExportExtractor();
    const analyses: FileAnalysis[] = [];
    for (const [filePath, src] of Object.entries(files)) {
      const tree = await parseSource(src, "javascript", filePath);
      analyses.push({ filePath, language: "javascript", imports: imports.extractImports(tree, src), routes: javascriptRouteExtractor.extractRoutes(tree, src, filePath) } as unknown as FileAnalysis);
    }
    expect(analyses[0]!.imports.map((i) => i.source)).toEqual(["./routes/clubs", "./routes/admin"]);
    resolveRouterMounts(analyses, buildImportIndex(analyses));
    expect(analyses.flatMap((a) => rows(a.routes))).toEqual(["GET /api/clubs/:id", "GET /admin/users"]);
  });
});
