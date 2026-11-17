import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * More shapes a Vuex mutation reaches the code watching its state, and the Nuxt auto-imported composable. Labels written by hand
 * from the sources below. A `Player` module holds the same names as the `Club` one and must never answer a `Club` watcher; a
 * helper two modules import writes the state of the one whose table takes it in; a second Nuxt app has its own `useClubs`.
 */
const FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", vuex: "^4.0.0" } }),
  "web/src/main.js": `import { createApp } from 'vue'
import App from './App.vue'
import store from './store'
createApp(App).use(store).mount('#app')
`,
  "web/src/App.vue": `<template><div><OptWatch /><StoreWatch /><CompMapState /><GetterWatch /><PlayerPanel /><Clicks /></div></template>
<script>
import OptWatch from './components/OptWatch.vue'
import StoreWatch from './components/StoreWatch.vue'
import CompMapState from './components/CompMapState.vue'
import GetterWatch from './components/GetterWatch.vue'
import PlayerPanel from './components/PlayerPanel.vue'
import Clicks from './components/Clicks.vue'
export default { components: { OptWatch, StoreWatch, CompMapState, GetterWatch, PlayerPanel, Clicks } }
</script>
`,
  "web/src/store/index.js": `import { createStore } from 'vuex'
import clubs from './clubs'
import players from './players'
export default createStore({ modules: { clubs, players } })
`,
  "web/src/store/helpers.js": `export const baseMutations = { TOUCH(state) { state.stamp = 1 } }
`,
  "web/src/store/clubs.js": `import { baseMutations } from './helpers'
export default {
  namespaced: true,
  state: () => ({ list: [], stamp: 0 }),
  getters: { total: (state) => state.list.length },
  mutations: { ...baseMutations, SET_LIST(state, v) { state.list = v } },
}
`,
  "web/src/store/players.js": `import { baseMutations } from './helpers'
export default {
  namespaced: true,
  state: () => ({ list: [], stamp: 0 }),
  getters: { total: (state) => state.list.length },
  mutations: { SET_LIST(state, v) { state.list = v } },
}
`,
  "web/src/components/OptWatch.vue": `<template><div /></template>
<script>
export default {
  created() { this.$watch('$store.state.clubs.list', this.onClubs) },
  methods: { onClubs() { console.log('c') } },
}
</script>
`,
  "web/src/components/StoreWatch.vue": `<template><div /></template>
<script setup>
import { useStore } from 'vuex'
const store = useStore()
store.watch((s) => s.clubs.list, () => onClubsStore())
function onClubsStore() { console.log('s') }
</script>
`,
  "web/src/components/CompMapState.vue": `<template><div /></template>
<script setup>
import { computed, watch } from 'vue'
import { useStore, mapState } from 'vuex'
const store = useStore()
const map = mapState('clubs', ['list'])
const list = computed(map.list.bind({ $store: store }))
watch(list, () => onMapped())
function onMapped() { console.log('m') }
</script>
`,
  "web/src/components/GetterWatch.vue": `<template><div /></template>
<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.getters['clubs/total'], () => onTotal())
function onTotal() { console.log('t') }
</script>
`,
  "web/src/components/PlayerPanel.vue": `<template><div /></template>
<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.state.players.stamp, () => onStamp())
watch(() => store.state.players.list, () => onPlayers())
function onStamp() { console.log('p') }
function onPlayers() { console.log('l') }
</script>
`,
  "web/src/components/Clicks.vue": `<template><button @click="a">a</button></template>
<script setup>
import { useStore } from 'vuex'
const store = useStore()
function a() { store.commit('clubs/SET_LIST', []) }
</script>
`,
  // a store with no `modules:`
  "garage/package.json": JSON.stringify({ name: "garage-web", dependencies: { vue: "^3.4.0", vuex: "^4.0.0" } }),
  "garage/src/main.js": `import { createApp } from 'vue'
import App from './App.vue'
import store from './store'
createApp(App).use(store).mount('#app')
`,
  "garage/src/App.vue": `<template><div><Gauge /><Bump /></div></template>
<script>
import Gauge from './Gauge.vue'
import Bump from './Bump.vue'
export default { components: { Gauge, Bump } }
</script>
`,
  "garage/src/store.js": `import { createStore } from 'vuex'
export default createStore({ state: { count: 0, fuel: 0 }, mutations: { INC(state) { state.count++ } } })
`,
  "garage/src/Gauge.vue": `<template><div /></template>
<script>
export default { watch: { '$store.state.count': 'onCount', '$store.state.fuel': 'onFuel' }, methods: { onCount() { console.log(1) }, onFuel() { console.log(2) } } }
</script>
`,
  "garage/src/Bump.vue": `<template><button @click="go">go</button></template>
<script setup>
import { useStore } from 'vuex'
const store = useStore()
function go() { store.commit('INC') }
</script>
`,
  // two Nuxt apps, each with its own auto-imported `useClubs`
  "nuxt-a/package.json": JSON.stringify({ name: "nuxt-a", dependencies: { nuxt: "^3.10.0", vue: "^3.4.0" } }),
  "nuxt-a/nuxt.config.ts": "export default defineNuxtConfig({})\n",
  "nuxt-a/composables/useClubs.js": `import { ref, computed } from 'vue'
export function useClubs() {
  const clubs = ref([])
  const total = computed(() => clubs.value.length)
  function load(rows) { clubs.value = rows }
  return { clubs, total, load }
}
`,
  "nuxt-a/pages/index.vue": `<template><button @click="go">go</button></template>
<script setup>
const { total, load } = useClubs()
const route = useRoute()
watch(total, () => onTotal())
watch(() => route.query.page, () => onPage())
function onTotal() { console.log('t') }
function onPage() { console.log('p') }
function go() { load([]) }
</script>
`,
  "nuxt-b/package.json": JSON.stringify({ name: "nuxt-b", dependencies: { nuxt: "^3.10.0", vue: "^3.4.0" } }),
  "nuxt-b/nuxt.config.ts": "export default defineNuxtConfig({})\n",
  "nuxt-b/composables/useClubs.js": `import { ref, computed } from 'vue'
export function useClubs() {
  const clubs = ref([])
  const total = computed(() => clubs.value.length)
  function load(rows) { clubs.value = rows }
  return { clubs, total, load }
}
`,
  "nuxt-b/pages/index.vue": `<template><button @click="go">go</button></template>
<script setup>
const { total, load } = useClubs()
watch(total, () => onTotal())
function onTotal() { console.log('t') }
function go() { load([]) }
</script>
`,
  // a plain Vue app (no nuxt.config): a `useLeague()` nothing imports is a global's or a plugin's, never the project function of that name
  "plain-vue/package.json": JSON.stringify({ name: "plain-vue", dependencies: { vue: "^3.4.0" } }),
  "plain-vue/composables/useLeague.js": `import { ref, computed } from 'vue'
export function useLeague() {
  const clubs = ref([])
  const total = computed(() => clubs.value.length)
  function load(rows) { clubs.value = rows }
  return { clubs, total, load }
}
`,
  "plain-vue/pages/index.vue": `<template><button @click="go">go</button></template>
<script setup>
const { total, load } = useLeague()
watch(total, () => onTotal())
function onTotal() { console.log('t') }
function go() { load([]) }
</script>
`,
};

describe("Vuex watchers written in code, a store without modules, a shared helper, Nuxt composables", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const all = (strategy: string) =>
    (summary.symbolLinks ?? []).filter((l) => l.strategy === strategy).map((l) => `${l.sourceFile.replace(/\/src\//, "/")}::${l.sourceSymbol} --${l.callName}--> ${l.targetFile.replace(/\/src\//, "/")}::${l.targetSymbol}`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-vuex-shapes-"));
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

  it("runs a watcher set by this.$watch, store.watch, a Composition mapState computed and a getter, never a namesake module's", () => {
    const watch = all("dispatch:vuex-state-watch").filter((l) => l.startsWith("web/store/"));
    expect(watch).toEqual(expect.arrayContaining([
      "web/store/clubs.js::mutations.SET_LIST --list--> web/components/OptWatch.vue::onClubs",
      "web/store/clubs.js::mutations.SET_LIST --list--> web/components/StoreWatch.vue::<watch@5>",
      "web/store/clubs.js::mutations.SET_LIST --list--> web/components/CompMapState.vue::<watch@8>",
      "web/store/clubs.js::mutations.SET_LIST --list--> web/components/GetterWatch.vue::<watch@6>",
    ]));
    // the `Player` module's `list` and `stamp` run only what watches the players
    expect(watch.filter((l) => l.includes("players.js"))).toEqual(["web/store/players.js::mutations.SET_LIST --list--> web/components/PlayerPanel.vue::<watch@7>"]);
    expect(watch.filter((l) => l.includes("PlayerPanel")).length).toBe(1);
  });

  it("gives a helper's mutation to the module whose table spreads it, not to every module importing the helper", () => {
    const watch = all("dispatch:vuex-state-watch");
    // `TOUCH` writes `stamp`: the `Club` table spreads it in, nobody watches `clubs.stamp`; `players.stamp` is watched, never written by it
    expect(watch.filter((l) => l.includes("helpers.js"))).toEqual([]);
    expect(watch.filter((l) => l.includes("PlayerPanel.vue::<watch@6>"))).toEqual([]);
  });

  it("treats a store without modules: as a root: its commits and state watchers join", () => {
    expect(all("dispatch:vuex-action")).toContain("garage/Bump.vue::go --commit:INC--> garage/store.js::mutations.INC");
    const watch = all("dispatch:vuex-state-watch").filter((l) => l.startsWith("garage/"));
    expect(watch).toEqual(["garage/store.js::mutations.INC --count--> garage/Gauge.vue::onCount"]);
  });

  it("joins an auto-imported composable to its own app's watcher, never another app's, and ignores built-ins", () => {
    const links = all("dispatch:store-watch");
    expect(links).toContain("nuxt-a/composables/useClubs.js::load --clubs--> nuxt-a/pages/index.vue::<watch@5>");
    expect(links.filter((l) => l.includes("nuxt-b/pages") && l.includes("nuxt-a"))).toEqual([]);
    expect(links.filter((l) => l.includes("nuxt-a/pages") && l.includes("nuxt-b"))).toEqual([]);
    // `useRoute()` is the framework's: the watcher on `route.query.page` joins nothing
    expect(links.filter((l) => l.includes("nuxt-a/pages"))).toHaveLength(1);
    // outside a Nuxt project an un-imported `useLeague()` joins nothing
    expect(links.filter((l) => l.includes("plain-vue/"))).toEqual([]);
  });
});
