import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/** One `children` array mounted under two parents (real-repo FP: the second parent's children were missing). */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "3.5.0", "vue-router": "4.4.0" } }),
  "src/router/player-children.ts": `export const playerDetailChildren = [
  { path: 'info', component: () => import('../views/PlayerInfo.vue') },
  { path: 'injuries', component: () => import('../views/PlayerInjuries.vue') },
];
`,
  "src/router/index.ts": `import { createRouter, createWebHistory } from 'vue-router';
import { playerDetailChildren } from './player-children';
export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/squad/players/:id', component: () => import('../views/PlayerDetail.vue'), children: playerDetailChildren },
    { path: '/academy/players/:id', component: () => import('../views/PlayerDetail.vue'), children: playerDetailChildren },
  ],
});
`,
  "src/views/PlayerDetail.vue": `<template><router-view /></template>\n`,
  "src/views/PlayerInfo.vue": `<template><p>info</p></template>\n`,
  "src/views/PlayerInjuries.vue": `<template><p>injuries</p></template>\n`,
};

describe("Vue Router children shared by two parents", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-shared-children-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the array's routes under each parent", () => {
    const paths = (summary.routeMap ?? []).filter((r) => r.kind === "frontend" && (r.filePath ?? "").endsWith("player-children.ts")).map((r) => r.path).sort();
    expect(paths).toEqual([
      "/academy/players/:id/info",
      "/academy/players/:id/injuries",
      "/squad/players/:id/info",
      "/squad/players/:id/injuries",
    ]);
  });
});
