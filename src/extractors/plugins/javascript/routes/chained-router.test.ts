import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";
import { JavaScriptImportExportExtractor } from "../imports-exports.js";
import { resolveRouterMounts } from "../../../shared/router-mounts.js";
import { buildImportIndex } from "../../../../core/import-index.js";
import type { FileAnalysis } from "../../../../types/analysis.js";

async function composed(files: Record<string, string>): Promise<string[]> {
  const imports = new JavaScriptImportExportExtractor();
  const analyses: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, "typescript", filePath);
    analyses.push({ filePath, language: "typescript", imports: imports.extractImports(tree, src), routes: javascriptRouteExtractor.extractRoutes(tree, src, filePath) } as unknown as FileAnalysis);
  }
  resolveRouterMounts(analyses, buildImportIndex(analyses));
  return analyses.flatMap((a) => a.routes.filter((r) => r.kind === "api").map((r) => `${r.httpMethod ?? "USE"} ${r.path}`)).sort();
}

const CLUBS = `import { Router } from 'express';
const router = Router();
router.get('/clubs', list);
router.post('/clubs/:id/join', join);
export default router;`;
const PLAYERS = `import { Router } from 'express';
const router = Router();
router.get('/players', list);
export default router;`;
const DECOYS = `import { Router } from 'express';
const router = Router();
router.get('/decoys', list);
export default router;`;

describe("a prefix mounted through a chained router", () => {
  it("composes Router().use(a).use(b) declared once, then exported and mounted by an app", async () => {
    expect(await composed({
      "routes/clubs.ts": CLUBS,
      "routes/players.ts": PLAYERS,
      "routes/decoys.ts": DECOYS,
      "routes.ts": `import { Router } from 'express';
import clubs from './routes/clubs';
import authController from './routes/players';
const api = Router().use(clubs).use(authController);
export default Router().use('/api', api);`,
      "main.ts": `import routes from './routes';
import decoys from './routes/decoys';
app.use(routes);
app.use(decoys);`,
    })).toEqual(["GET /api/clubs", "GET /api/players", "GET /decoys", "POST /api/clubs/:id/join"]);
  });

  it("keeps one row per prefix when the chained router is mounted twice", async () => {
    expect(await composed({
      "routes/players.ts": PLAYERS,
      "routes.ts": `import { Router } from 'express';
import players from './routes/players';
export default Router().use(players);`,
      "main.ts": `import routes from './routes';
app.use('/v1', routes);
app.use('/v2', routes);`,
    })).toEqual(["GET /v1/players", "GET /v2/players"]);
  });

  it("composes a chain exported as the module's router, and a name that is no router file adds nothing", async () => {
    expect(await composed({
      "routes/clubs.ts": CLUBS,
      "routes.ts": `import { Router } from 'express';
import clubs from './routes/clubs';
import requireAuth from './auth';
export default Router().use(requireAuth).use(clubs);`,
      "auth.ts": `export default function requireAuth(req, res, next) { next(); }`,
      "main.ts": `import routes from './routes';
app.use('/api', routes);`,
    })).toEqual(["GET /api/clubs", "POST /api/clubs/:id/join"]);
  });

  it("leaves a chain handed to another call alone, and prefixes a cross-file router mounted under a local one", async () => {
    expect(await composed({
      "routes/clubs.ts": CLUBS,
      "routes/players.ts": PLAYERS,
      "main.ts": `import clubs from './routes/clubs';
import players from './routes/players';
app.use('/api', Router().use(clubs));
const league = Router();
league.use('/squad', players);
app.use('/league', league);`,
    })).toEqual(["GET /clubs", "GET /league/squad/players", "POST /clubs/:id/join"]);
  });
});
