import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/** A hand-rolled router (real-repo FP): a `{ path, screen }` table and a layout showing each screen by that key. */
const FILES: Record<string, string> = {
  "package.json": `{ "name": "league", "dependencies": { "vue": "3.5.0" } }\n`,
  "src/config/routes.ts": `export const routes = [
  { name: 'home', path: '/home', screen: 'Home', title: 'Home' },
  { name: 'clubs', path: '/clubs/:id', screen: 'Club', title: 'Club' },
  { name: 'fixtures', path: '/fixtures', screen: 'Fixtures' },
  { name: 'gone', path: '/gone', screen: 'Gone' },
]
`,
  "src/components/MainContent.vue": `<template>
  <section>
    <HomeScreen v-show="screen === 'Home'" />
    <ClubScreen v-if="screen === 'Club'" />
    <FixturesScreen v-if="screen === 'Fixtures'" />
  </section>
</template>

<script lang="ts" setup>
import { defineAsyncComponent, ref } from 'vue'
import HomeScreen from './screens/HomeScreen.vue'
const ClubScreen = defineAsyncComponent(() => import('./screens/ClubScreen.vue'))
const FixturesScreen = defineAsyncComponent(
  () => import('./screens/FixturesScreen.vue'),
)
const screen = ref('Home')
</script>
`,
  "src/components/screens/HomeScreen.vue": `<template><div><button @click="go">Go</button></div></template>\n<script lang="ts" setup>\nconst go = () => {}\n</script>\n`,
  "src/components/screens/ClubScreen.vue": `<template><div><button @click="load">Load</button></div></template>\n<script lang="ts" setup>\nconst load = () => {}\n</script>\n`,
  "src/components/screens/FixturesScreen.vue": `<template><div><button @click="load">Load</button></div></template>\n<script lang="ts" setup>\nconst load = () => {}\n</script>\n`,
};

describe("a hand-rolled { path, screen } router", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-screen-table-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("routes each entry to the component the layout shows for its key, imported or lazily bound", () => {
    const routes = summary.routeMap.filter((r) => r.kind === "frontend").map((r) => `${r.path} -> ${r.componentPath}`).sort();
    expect(routes).toEqual([
      "/clubs/:id -> src/components/screens/ClubScreen.vue",
      "/fixtures -> src/components/screens/FixturesScreen.vue",
      "/home -> src/components/screens/HomeScreen.vue",
    ]);
    const paged = summary.screens.filter((s) => s.routePath).map((s) => `${s.filePath} ${s.routePath}`).sort();
    expect(paged).toEqual([
      "src/components/screens/ClubScreen.vue /clubs/:id",
      "src/components/screens/FixturesScreen.vue /fixtures",
      "src/components/screens/HomeScreen.vue /home",
    ]);
  });
});
