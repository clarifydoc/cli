import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractFunctions } from "../../../functions-classes/index.js";
import { extractImports } from "../../../imports-exports/index.js";
import { buildImportIndex } from "../../../../core/import-index.js";
import { buildClassIndex } from "../../../../core/class-index.js";
import { javascriptRouteExtractor } from "./index.js";
import { reactRouterResolver } from "./react-router-resolver.js";
import type { FileAnalysis, RouteFact } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";

async function project(files: Record<string, string>): Promise<FileAnalysis[]> {
  const analyses: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, "javascript" as never, filePath);
    const routeFacts: RouteFact[] = [];
    analyses.push({
      filePath, language: "javascript", projectId: "root", exports: [], classes: [], entityRelations: [],
      imports: extractImports(tree, src, "javascript" as never),
      functions: extractFunctions(tree, src, "javascript" as never),
      routes: javascriptRouteExtractor.extractRoutes(tree, src, filePath, routeFacts),
      routeFacts,
    } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(analyses);
  reactRouterResolver.resolve(analyses, { importIndex, classes: buildClassIndex(analyses, importIndex) } as ProjectContext);
  return analyses;
}

const HELPER = `export const appURL = (path, params) => {
  const query = params ? \`?\${new URLSearchParams(params)}\` : '';
  return \`/app/\${path}\${query}\`;
};`;

describe("Vue Router paths a project helper builds", () => {
  it("fills `path: helper('…')` from the helper's template, and composes children under it", async () => {
    const analyses = await project({
      "helper/url.js": HELPER,
      "routes/league.routes.js": `import { appURL } from '../helper/url';
import LeagueTable from './LeagueTable.vue';
import ClubPage from './ClubPage.vue';
import FixturesPage from './FixturesPage.vue';
export default {
  routes: [
    { path: appURL('leagues/:leagueId/table'), name: 'league_table', component: LeagueTable },
    {
      path: appURL('leagues/:leagueId/clubs'),
      component: ClubPage,
      children: [
        { path: 'fixtures', name: 'club_fixtures', component: FixturesPage },
        { path: appURL('leagues/:leagueId/clubs/:clubId'), name: 'club_show', component: ClubPage },
      ],
    },
  ],
};`,
    });
    const routes = analyses.find((a) => a.filePath === "routes/league.routes.js")!.routes;
    expect(routes.map((r) => `${r.path} ${r.handler}`)).toEqual([
      "/app/leagues/:leagueId/table LeagueTable",
      "/app/leagues/:leagueId/clubs ClubPage",
      "/app/leagues/:leagueId/clubs/fixtures FixturesPage",
      "/app/leagues/:leagueId/clubs/:clubId ClubPage",
    ]);
  });

  it("places a local array spread into a helper-built parent's children under it", async () => {
    const analyses = await project({
      "helper/url.js": HELPER,
      "routes/stats.routes.js": `import { appURL } from '../helper/url';
import StatsShell from './StatsShell.vue';
import Scorers from './Scorers.vue';
import Assists from './Assists.vue';
const statRoutes = [
  { path: 'scorers', name: 'stats_scorers', component: Scorers },
  { path: 'assists/:playerId', name: 'stats_assists', component: Assists },
];
export default {
  routes: [{ path: appURL('leagues/:leagueId/stats'), component: StatsShell, children: [...statRoutes] }],
};`,
    });
    const routes = analyses.find((a) => a.filePath === "routes/stats.routes.js")!.routes;
    expect(routes.map((r) => r.path).sort()).toEqual([
      "/app/leagues/:leagueId/stats",
      "/app/leagues/:leagueId/stats/assists/:playerId",
      "/app/leagues/:leagueId/stats/scorers",
    ]);
  });

  it("drops a route whose helper the project does not define", async () => {
    const analyses = await project({
      "routes/garage.routes.js": `import { carURL } from 'some-package';
import Garage from './Garage.vue';
export default [{ path: carURL('garage'), component: Garage }];`,
    });
    expect(analyses[0]!.routes).toEqual([]);
  });
});
