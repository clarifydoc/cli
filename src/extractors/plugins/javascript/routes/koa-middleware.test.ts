import { describe, it, expect } from "vitest";
import "../../../registry.js";
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";
import { koaAppMiddleware } from "./koa-middleware.js";
import { reconcileProjectRoutes } from "../../../route-resolvers/index.js";
import { buildImportIndex } from "../../../../core/import-index.js";
import { buildClassIndex } from "../../../../core/class-index.js";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";

async function routesOf(src: string, file = "server.ts", facts: RouteFact[] = []): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "typescript", file);
  return javascriptRouteExtractor.extractRoutes(tree, src, file, facts);
}

async function project(files: Record<string, string>): Promise<FileAnalysis[]> {
  const analyses: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const facts: RouteFact[] = [];
    const tree = await parseSource(src, "typescript", filePath);
    analyses.push({
      filePath,
      language: "typescript",
      projectId: "panel",
      classes: [],
      functions: [],
      imports: [],
      routes: await routesOf(src, filePath, facts),
      routeFacts: facts,
    } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(analyses);
  const known = new Set(analyses.map((a) => a.filePath));
  const ctx: ProjectContext = {
    importIndex,
    classes: buildClassIndex(analyses, importIndex),
    resolveModule: () => null,
    fileOf: (p) => analyses.find((a) => a.filePath === p),
  };
  reconcileProjectRoutes(analyses, ctx, [koaAppMiddleware]);
  return analyses;
}

describe("Koa middleware reach", () => {
  it("router.use and app.use before a mount chain reach routes on a nested router", async () => {
    const routes = await routesOf(`
      import Koa from 'koa';
      import Router from '@koa/router';
      const app = new Koa();
      const api = new Router({ prefix: '/api' });
      const clubs = new Router();
      app.use(loadSeason);
      api.use(checkLeague);
      clubs.get('/clubs', listClubs);
      api.use(clubs.routes());
      app.use(api.routes());
      http.createServer(app.callback());
    `);
    const row = routes.find((r) => r.httpMethod === "GET" && r.path === "/clubs")!;
    expect(row.middlewareCalls?.sort()).toEqual(["checkLeague", "loadSeason"]);
  });

  it("names only imported middleware on a Koa bootstrap; anonymous app.use stays silent", async () => {
    const facts: RouteFact[] = [];
    await routesOf(
      `import Koa from 'koa';
       import { preCheckMiddleware } from './middleware/precheck';
       const app = new Koa();
       app.use(async (ctx, next) => { await next(); });
       app.use(preCheckMiddleware);
       app.use(protocolMiddleware);
       mountRouters(app);`,
      "src/app.ts",
      facts,
    );
    expect(facts).toEqual([{ kind: "koa-app-middleware", line: 1, data: { calls: ["preCheckMiddleware", "protocolMiddleware"] } }]);
  });

  it("does not emit a koa-app fact for Express with the same app.use shape", async () => {
    const facts: RouteFact[] = [];
    await routesOf(
      `import express from 'express';
       const app = express();
       app.use(wardStadium);
       app.get('/health', (_, res) => res.send('ok'));
       app.listen(3000);`,
      "server.ts",
      facts,
    );
    expect(facts.filter((f) => f.kind === "koa-app-middleware")).toEqual([]);
  });

  it("inheritedMiddleware on routes in another file names the bootstrap middleware", async () => {
    const analyses = await project({
      "src/app.ts": `import Koa from 'koa';
        import { mountRouters } from './index';
        const app = new Koa();
        app.use(preCheckMiddleware);
        mountRouters(app);`,
      "src/routers/venues_router.ts": `import Router from '@koa/router';
        const router = new Router();
        router.get('/venues', listVenues);
        export default router;`,
    });
    const route = analyses.find((a) => a.filePath === "src/routers/venues_router.ts")!.routes[0]!;
    expect(route.inheritedMiddleware).toEqual([{ file: "src/app.ts", calls: ["preCheckMiddleware"] }]);
  });
});