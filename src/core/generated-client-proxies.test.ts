import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Real-repo FP: ~200 calls on TypeScript clients generated (git-ignored) from the
 * repository's own jsight specs were plain cross-file calls — no screen reached a route.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-portal", dependencies: { vue: "3.4.0" } }),
  "src/api/league-ui-api.jsight": `JSIGHT 0.3

GET /find-clubs
  Query "search=xxx"
  200
    @ClubList

GET /fixtures/{season}
  Path
    {
      "season": "season"
    }
  200
    @FixtureList
`,
  "src/api/index.ts": `import { LeagueUiApi } from './generated/league-ui-api';
export const uiApi = new LeagueUiApi(import.meta.env.VITE_LEAGUE_URL);
`,
  "src/services/clubService.ts": `import { uiApi } from '../api';
class ClubService {
  async find(search: string) {
    return (await uiApi.getFindClubs(search)).data;
  }
}
export const clubService = new ClubService();
`,
  "src/components/FixtureWidget.vue": `<script setup lang="ts">
import { LeagueUiApi } from '../api/generated/league-ui-api';
const api = new LeagueUiApi(import.meta.env.VITE_LEAGUE_URL);
async function load(season: string) {
  return (await api.getFixturesBySeason(season)).data;
}
</script>
<template><button @click="load('2024')">Load</button></template>
`,
};

describe("calls on a generated API client the tree does not hold", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-generated-clients-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("are requests to the spec's operations, through an instance a module exports or a local one", () => {
    const routes = summary.routeMap.filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path} ${r.contract?.type}#${r.contract?.method}`);
    expect(routes).toEqual(expect.arrayContaining(["GET /find-clubs LeagueUiApi#getFindClubs"]));
    const links = (summary.apiRouteLinks ?? []).map((l) => `${l.source} → ${l.method ?? "?"} ${l.routePath} ${l.matchedVia}`).sort();
    expect(links).toEqual([
      "src/components/FixtureWidget.vue → GET /fixtures/{season} contract",
      "src/services/clubService.ts → GET /find-clubs contract",
    ]);
  });
});
