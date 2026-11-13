import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A component watching state a store holds runs when an action of that store writes it — the store is another
 * file's, so the join is by the store the factory resolves to, never by the state's name. Labels written by hand
 * from the sources below; every positive case has a namesake: a car store with a `filters.league` of its own, a
 * component's local `filters` ref, a store member nobody watches.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", pinia: "^2.1.0", axios: "^1.6.0", express: "^4.18.0", pg: "^8.11.0" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  "server/index.js": `const express = require('express')
const { Pool } = require('pg')
const pool = new Pool()
const app = express()
app.get('/api/league/standings', async (req, res) => res.json((await pool.query('SELECT * FROM standings')).rows))
app.get('/api/league/fixtures', async (req, res) => res.json((await pool.query('SELECT * FROM fixtures')).rows))
app.get('/api/league/scorers', async (req, res) => res.json((await pool.query('SELECT * FROM scorers')).rows))
app.get('/api/league/transfers', async (req, res) => res.json((await pool.query('SELECT * FROM transfers')).rows))
app.get('/api/league/audits', async (req, res) => res.json((await pool.query('SELECT * FROM audits')).rows))
app.get('/api/league/training', async (req, res) => res.json((await pool.query('SELECT * FROM drills')).rows))
app.get('/api/cars/models', async (req, res) => res.json((await pool.query('SELECT * FROM car_models')).rows))
app.listen(3000)
`,
  "src/stores/club-store.ts": `import { defineStore } from 'pinia'

export const useClubStore = defineStore('clubs', {
  state: () => ({ filters: { league: null as number | null, season: 1 }, picked: [] as number[], drawer: true }),
  actions: {
    setLeague(id: number) {
      this.filters.league = id
    },
    reset() {
      this.filters = { league: null, season: 1 }
    },
    pick(id: number) {
      this.picked.push(id)
    },
    closeDrawer() {
      this.drawer = false
    },
    openDrawer() {
      this.drawer = true
    },
  },
})
`,
  "src/stores/index.ts": `export { useClubStore } from './club-store'
export { useCarStore } from './car-store'
`,
  "src/components/ClubBarrel.vue": `<script setup lang="ts">
import { watch } from 'vue'
import axios from 'axios'
import { useClubStore } from '@/stores'

const store = useClubStore()

watch(() => store.filters.season, async () => {
  await axios.get('/api/league/scorers')
})
</script>
<template><div>barrel</div></template>
`,
  "src/components/ClubDrawer.vue": `<script setup lang="ts">
import { whenever } from '@vueuse/core'
import axios from 'axios'
import { useClubStore } from '@/stores/club-store'

const store = useClubStore()

whenever(() => store.drawer, async () => {
  await axios.get('/api/league/fixtures')
})
</script>
<template><div>drawer</div></template>
`,
  "src/components/ClubAudit.vue": `<script setup lang="ts">
import { watch } from 'vue'
import axios from 'axios'
import { useClubStore } from '@/stores/club-store'

const store = useClubStore()

watch(store, async () => {
  await axios.get('/api/league/audits')
}, { deep: true, immediate: true })
</script>
<template><div>audit</div></template>
`,
  "src/components/ClubAuditCopy.vue": `<script setup lang="ts">
import { watch } from 'vue'
import axios from 'axios'
import { useClubStore } from '@/stores/club-store'

const store = useClubStore()

watch(store, async () => {
  await axios.get('/api/league/audits')
}, { deep: true, immediate: true })
</script>
<template><div>audit copy</div></template>
`,
  "src/stores/car-store.ts": `import { defineStore } from 'pinia'

export const useCarStore = defineStore('cars', {
  state: () => ({ filters: { league: null as number | null }, picked: [] as number[] }),
  actions: {
    setLeague(id: number) {
      this.filters.league = id
    },
    pick(id: number) {
      this.picked.push(id)
    },
  },
})
`,
  "src/stores/squad-store.ts": `import { defineStore } from 'pinia'
import { ref, shallowReactive } from 'vue'

export const useSquadStore = defineStore('squad', () => {
  const filters = ref({ position: 'GK' })
  function setPosition(p: string) {
    filters.value.position = p
  }
  const shape = shallowReactive({ formation: '442' })
  function setFormation(f: string) {
    shape.formation = f
  }
  return { filters, setPosition, shape, setFormation }
})
`,
  "src/components/SquadFormation.vue": `<script setup lang="ts">
import { watch } from 'vue'
import axios from 'axios'
import { useSquadStore } from '@/stores/squad-store'

const squad = useSquadStore()

watch(() => squad.shape.formation, async () => {
  await axios.get('/api/league/fixtures')
})
</script>
<template><div>formation</div></template>
`,
  "src/stores/training-store.ts": `import { defineStore } from 'pinia'

export const useTrainingStore = defineStore('training', {
  state: () => ({ drill: 'passing', minutes: 0 }),
  actions: {
    start(drill: string) {
      this.$patch({ drill })
    },
    tick() {
      this.$patch((s) => {
        s.minutes++
      })
    },
  },
})
`,
  "src/components/ClubTable.vue": `<script setup lang="ts">
import { watch } from 'vue'
import axios from 'axios'
import { useClubStore } from '@/stores/club-store'

const store = useClubStore()

watch(() => store.filters.league, async () => {
  await axios.get('/api/league/standings')
})
</script>
<template><div>table</div></template>
`,
  "src/components/ClubFixtures.vue": `<script setup lang="ts">
import { watch } from 'vue'
import axios from 'axios'
import { storeToRefs } from 'pinia'
import { useClubStore } from '@/stores/club-store'

const store = useClubStore()
const { filters } = storeToRefs(store)

watch(filters, async () => {
  await axios.get('/api/league/fixtures')
}, { deep: true })
</script>
<template><div>fixtures</div></template>
`,
  "src/components/ClubScorers.vue": `<script setup lang="ts">
import { watch, computed } from 'vue'
import axios from 'axios'
import { useClubStore } from '@/stores/club-store'

const store = useClubStore()
const season = computed(() => store.filters.season)

watch(season, async () => {
  await axios.get('/api/league/scorers')
})
</script>
<template><div>scorers</div></template>
`,
  "src/components/CarTable.vue": `<script setup lang="ts">
import { watch } from 'vue'
import axios from 'axios'
import { useCarStore } from '@/stores/car-store'

const store = useCarStore()

watch(() => store.filters.league, async () => {
  await axios.get('/api/cars/models')
})
</script>
<template><div>cars</div></template>
`,
  "src/components/LocalFilters.vue": `<script setup lang="ts">
import { ref, watch } from 'vue'
import axios from 'axios'

const filters = ref({ league: 1 })

watch(filters, async () => {
  await axios.get('/api/league/transfers')
}, { deep: true })
</script>
<template><div>local</div></template>
`,
  "src/components/SquadView.vue": `<script setup lang="ts">
import { watch } from 'vue'
import axios from 'axios'
import { useSquadStore } from '@/stores/squad-store'

const squad = useSquadStore()

watch(() => squad.filters.position, async () => {
  await axios.get('/api/league/transfers')
})
</script>
<template><div>squad</div></template>
`,
  "src/components/TrainingBoard.vue": `<script setup lang="ts">
import { watchEffect } from 'vue'
import axios from 'axios'

const training = useTrainingStore()

watchEffect(() => {
  axios.get('/api/league/training', { params: { drill: training.drill } })
})
</script>
<template><div>board</div></template>
`,
  "src/components/LeaguePicker.vue": `<script setup lang="ts">
import { useClubStore } from '@/stores/club-store'
import { useSquadStore } from '@/stores/squad-store'
const clubs = useClubStore()
const squad = useSquadStore()
function chooseLeague() { clubs.setLeague(3) }
function chooseKeeper() { squad.setPosition('GK') }
</script>
<template>
  <button @click="chooseLeague">league</button>
  <button @click="chooseKeeper">keeper</button>
</template>
`,
};

describe("store state watchers", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-store-watch-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const watchLinks = () =>
    summary.symbolLinks.filter((l) => l.strategy === "dispatch:store-watch").map((l) => `${l.sourceFile}:${l.sourceSymbol} -> ${l.targetFile}:${l.targetSymbol}`);

  it("runs a watcher of a store member when an action of that store writes it", () => {
    const links = watchLinks();
    // `() => store.filters.league`: a write to the member, and one replacing the object above it.
    expect(links).toContain("src/stores/club-store.ts:ClubStore.setLeague -> src/components/ClubTable.vue:<watch@8>");
    expect(links).toContain("src/stores/club-store.ts:ClubStore.reset -> src/components/ClubTable.vue:<watch@8>");
  });

  it("follows a storeToRefs ref watched deep and a computed over store state", () => {
    const links = watchLinks();
    expect(links).toContain("src/stores/club-store.ts:ClubStore.setLeague -> src/components/ClubFixtures.vue:<watch@10>");
    expect(links).toContain("src/stores/club-store.ts:ClubStore.reset -> src/components/ClubFixtures.vue:<watch@10>");
    // `computed(() => store.filters.season)`: only the action replacing `filters` writes it.
    expect(links).toContain("src/stores/club-store.ts:ClubStore.reset -> src/components/ClubScorers.vue:<watch@9>");
    expect(links).not.toContain("src/stores/club-store.ts:ClubStore.setLeague -> src/components/ClubScorers.vue:<watch@9>");
  });

  it("joins a setup store's function writing a returned ref", () => {
    expect(watchLinks()).toContain("src/stores/squad-store.ts:setPosition -> src/components/SquadView.vue:<watch@8>");
  });

  it("reads `$patch` as a write of the keys it names, or of whatever its callback touches, and an auto-imported factory", () => {
    const links = watchLinks();
    expect(links).toContain("src/stores/training-store.ts:TrainingStore.start -> src/components/TrainingBoard.vue:<watchEffect@7>");
    expect(links).not.toContain("src/stores/training-store.ts:TrainingStore.tick -> src/components/TrainingBoard.vue:<watchEffect@7>");
  });

  it("finds the store through a barrel that only re-exports its factory", () => {
    expect(watchLinks()).toContain("src/stores/club-store.ts:ClubStore.reset -> src/components/ClubBarrel.vue:<watch@8>");
  });

  it("never runs a truthy-only watcher for a switch-off write", () => {
    const links = watchLinks();
    expect(links).toContain("src/stores/club-store.ts:ClubStore.openDrawer -> src/components/ClubDrawer.vue:<whenever@8>");
    expect(links).not.toContain("src/stores/club-store.ts:ClubStore.closeDrawer -> src/components/ClubDrawer.vue:<whenever@8>");
  });

  it("watches a whole store through, and runs an immediate watcher from the setup of each file", () => {
    const links = watchLinks();
    expect(links).toContain("src/stores/club-store.ts:ClubStore.pick -> src/components/ClubAudit.vue:<watch@8>");
    expect(links).toContain("src/components/ClubAudit.vue:<setup> -> src/components/ClubAudit.vue:<watch@8>");
    expect(links).toContain("src/components/ClubAuditCopy.vue:<setup> -> src/components/ClubAuditCopy.vue:<watch@8>");
  });

  it("sees a top-level write to a shallow reactive object a setup store returns", () => {
    expect(watchLinks()).toContain("src/stores/squad-store.ts:setFormation -> src/components/SquadFormation.vue:<watch@8>");
  });

  it("never joins another store's state of the same name, a component's own ref, or a member nobody watches", () => {
    const links = watchLinks();
    expect(links.filter((l) => l.includes("CarTable.vue"))).toEqual(["src/stores/car-store.ts:CarStore.setLeague -> src/components/CarTable.vue:<watch@8>"]);
    expect(links.filter((l) => l.startsWith("src/stores/car-store.ts"))).toHaveLength(1);
    expect(links.filter((l) => l.includes("LocalFilters.vue"))).toEqual([]);
    expect(links.filter((l) => l.includes("ClubStore.pick") && !l.includes("ClubAudit"))).toEqual([]);
    expect(links.filter((l) => l.includes("SquadView.vue"))).toHaveLength(1);
  });

  it("a click on the action reaches the watcher's request and the table behind it", () => {
    const reach = summary.symbolReach?.find((r) => r.file === "src/components/LeaguePicker.vue" && r.symbol === "chooseLeague");
    const effects = reach?.effects.map((e) => `${e.kind} ${e.originFile}:${e.originSymbol}${e.kind === "api-call" ? "" : ` ${e.resource}`}`);
    expect(effects).toEqual(expect.arrayContaining([
      "api-call src/components/ClubTable.vue:<watch@8>",
      "db-read server/index.js:route:GET /api/league/standings standings",
    ]));
    // The keeper button reaches the squad watcher only; the car store's request is nobody's click here.
    const keeper = summary.symbolReach?.find((r) => r.file === "src/components/LeaguePicker.vue" && r.symbol === "chooseKeeper");
    expect(keeper?.effects.map((e) => e.originFile).filter((f) => f.includes("Car"))).toEqual([]);
  });
});
