import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Vuex state a component watches and a mutation writes, mutation tables built from other objects, and a composable's
 * computed watched from another file. Labels written by hand from the sources below; every `Player` module holds the
 * same names as the `Club` one and must never be joined to a `Club` watcher or commit.
 */
const FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", vuex: "^4.0.0", pinia: "^2.0.0" } }),
  "web/src/main.js": `import { createApp } from 'vue'
import App from './App.vue'
import store from './store'
createApp(App).use(store).mount('#app')
`,
  "web/src/App.vue": `<template><div><ClubWatch /><ClubMapped /><ClubSetup /><ClubClick /><ClubTotal /><PlayerTotal /></div></template>
<script>
import ClubWatch from './components/ClubWatch.vue'
import ClubMapped from './components/ClubMapped.vue'
import ClubSetup from './components/ClubSetup.vue'
import ClubClick from './components/ClubClick.vue'
import ClubTotal from './components/ClubTotal.vue'
import PlayerTotal from './components/PlayerTotal.vue'
export default { components: { ClubWatch, ClubMapped, ClubSetup, ClubClick, ClubTotal, PlayerTotal } }
</script>
`,
  "web/src/store/index.js": `import { createStore } from 'vuex'
import clubs from './clubs'
import players from './players'
import teams from './teams'
export default createStore({ modules: { clubs, players, teams } })
`,
  "web/src/store/base.js": `export const baseMutations = {
  RESET_CLUBS(state) { state.list = [] },
}
export const extraMutations = {
  TOUCH(state) { state.filters = { ...state.filters, touched: true } },
}
`,
  "web/src/store/clubs.js": `import { baseMutations, extraMutations } from './base'
const state = () => ({ list: [], filters: {}, byId: new Map() })
const mutations = {
  ...baseMutations,
  SET_LIST(state, v) { state.list = [...v] },
  MERGE_FILTERS(state, p) { Object.assign(state.filters, p) },
  ADD_ONE(state, c) { state.byId.set(c.id, c) },
  APPEND(state, c) { state.list.push(c) },
}
export default { namespaced: true, state, mutations: Object.assign({}, mutations, extraMutations) }
`,
  "web/src/store/players.js": `const state = () => ({ list: [], filters: {}, byId: new Map() })
const mutations = {
  SET_LIST(state, v) { state.list = v },
  MERGE_FILTERS(state, p) { Object.assign(state.filters, p) },
  RESET_CLUBS(state) { state.list = [] },
  ADD_ONE(state, c) { state.byId.set(c.id, c) },
}
export default { namespaced: true, state, mutations }
`,
  "web/src/store/factory.js": `export const crudMutations = { RESET_ROWS(state) { state.rows = [] } }
export const createModule = (options) => ({
  namespaced: true,
  state: () => ({ rows: [] }),
  mutations: { ...crudMutations, ...options.mutations },
})
`,
  "web/src/store/teams.js": `import { createModule } from './factory'
export default createModule({ name: 'Team', mutations: { ADD_ROW(state, r) { state.rows = [...state.rows, r] } } })
`,
  "web/src/components/ClubWatch.vue": `<template><div /></template>
<script>
export default {
  watch: { '$store.state.clubs.list': 'onList', '$store.state.clubs.filters': { handler() { this.onFilters() }, deep: true } },
  methods: { onList() { console.log('l') }, onFilters() { console.log('f') } },
}
</script>
`,
  "web/src/components/ClubMapped.vue": `<template><div /></template>
<script>
import { mapState } from 'vuex'
export default {
  computed: { ...mapState('clubs', ['list']) },
  watch: { list() { this.refresh() } },
  methods: { refresh() { console.log('r') } },
}
</script>
`,
  "web/src/components/ClubSetup.vue": `<template><div /></template>
<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.state.clubs.byId, () => syncIds(), { deep: true })
function syncIds() { console.log('s') }
</script>
`,
  "web/src/components/ClubClick.vue": `<template><button @click="reset">go</button></template>
<script setup>
import { useStore } from 'vuex'
const store = useStore()
function reset() { store.commit('clubs/RESET_CLUBS') }
function touch() { store.commit('clubs/TOUCH') }
function add() { store.commit('clubs/ADD_ONE', {}) }
function resetTeams() { store.commit('teams/RESET_ROWS') }
</script>
`,
  "web/src/composables/useClubs.js": `import { ref, computed } from 'vue'
export function useClubs() {
  const clubs = ref([])
  const filter = ref('')
  const total = computed(() => clubs.value.length)
  const visible = computed(() => clubs.value.filter((c) => c.name.includes(filter.value)))
  function load(rows) { clubs.value = rows }
  function setFilter(f) { filter.value = f }
  return { clubs, total, visible, load, setFilter }
}
`,
  "web/src/composables/usePlayers.js": `import { ref, computed } from 'vue'
export function usePlayers() {
  const players = ref([])
  const total = computed(() => players.value.length)
  function load(rows) { players.value = rows }
  return { players, total, load }
}
`,
  "web/src/components/ClubTotal.vue": `<template><button @click="go">go</button></template>
<script setup>
import { watch } from 'vue'
import { useClubs } from '../composables/useClubs'
const { total, visible, load, setFilter } = useClubs()
watch(total, () => { refreshStandings() })
watch(visible, () => { refreshFixtures() })
function refreshStandings() {}
function refreshFixtures() {}
function go() { load([]) }
function narrow() { setFilter('x') }
</script>
`,
  "web/src/components/ClubBadge.vue": `<template><div /></template>
<script setup>
import { watch } from 'vue'
import { useClubs } from '../composables/useClubs'
const { total } = useClubs()
watch(total, () => { refreshBadge() })
function refreshBadge() {}
</script>
`,
  "web/src/composables/useSession.js": `import { ref } from 'vue'
const user = ref(null)
export function useSession() {
  function login(u) { user.value = u }
  return { user, login }
}
`,
  "web/src/components/SessionMenu.vue": `<template><div /></template>
<script setup>
import { watch } from 'vue'
import { useSession } from '../composables/useSession'
const { user } = useSession()
watch(user, () => { refreshMenu() })
function refreshMenu() {}
</script>
`,
  "web/src/components/SessionLogin.vue": `<template><button @click="go">go</button></template>
<script setup>
import { useSession } from '../composables/useSession'
const { login } = useSession()
function go() { login({}) }
</script>
`,
  "web/src/components/PlayerTotal.vue": `<template><button @click="go">go</button></template>
<script setup>
import { watch } from 'vue'
import { usePlayers } from '../composables/usePlayers'
const { total, load } = usePlayers()
watch(total, () => { refreshPlayers() })
function refreshPlayers() {}
function go() { load([]) }
</script>
`,
};

describe("Vuex mutations and state watchers, composable computeds", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  const all = (strategy: string) =>
    (summary.symbolLinks ?? []).filter((l) => l.strategy === strategy).map((l) => `${l.sourceFile.replace("web/src/", "")}::${l.sourceSymbol} --${l.callName}--> ${l.targetFile.replace("web/src/", "")}::${l.targetSymbol}`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-vuex-state-"));
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

  it("joins a commit to a mutation spread in or merged by Object.assign, never to a namesake of another module", () => {
    const commits = all("dispatch:vuex-action").filter((l) => l.startsWith("components/ClubClick.vue"));
    expect(commits).toEqual(expect.arrayContaining([
      "components/ClubClick.vue::reset --commit:clubs/RESET_CLUBS--> store/base.js::baseMutations.RESET_CLUBS",
      "components/ClubClick.vue::touch --commit:clubs/TOUCH--> store/base.js::extraMutations.TOUCH",
      "components/ClubClick.vue::add --commit:clubs/ADD_ONE--> store/clubs.js::mutations.ADD_ONE",
    ]));
    // a module a project factory builds: the table it spreads in from the factory's own file
    expect(commits).toContain("components/ClubClick.vue::resetTeams --commit:teams/RESET_ROWS--> store/factory.js::crudMutations.RESET_ROWS");
    expect(commits.join("\n")).not.toContain("players.js");
  });

  it("runs a watcher of Vuex state when a mutation of the module writes it", () => {
    const watch = all("dispatch:vuex-state-watch");
    expect(watch).toEqual(expect.arrayContaining([
      // `'$store.state.clubs.list': 'onList'`, a mutation spread in from another file, a module's own
      "store/clubs.js::mutations.SET_LIST --list--> components/ClubWatch.vue::onList",
      "store/base.js::baseMutations.RESET_CLUBS --list--> components/ClubWatch.vue::onList",
      // a deep watcher on the object a merge and a spread-assign write below
      "store/clubs.js::mutations.MERGE_FILTERS --filters--> components/ClubWatch.vue::<watch@4>",
      "store/base.js::extraMutations.TOUCH --filters--> components/ClubWatch.vue::<watch@4>",
      // `...mapState('clubs', ['list'])` and a watcher named for the computed
      "store/clubs.js::mutations.SET_LIST --list--> components/ClubMapped.vue::list",
      // `useStore()` and `store.state.clubs.byId` read through
      "store/clubs.js::mutations.ADD_ONE --byId--> components/ClubSetup.vue::<watch@6>",
    ]));
  });

  it("never joins a watcher to another module's state of the same name, nor to a push a shallow watcher does not see", () => {
    const watch = all("dispatch:vuex-state-watch").join("\n");
    expect(watch).not.toContain("players.js");
    expect(watch).not.toContain("mutations.APPEND");
  });

  it("runs a watcher on a composable's computed when a function of the composable writes a ref it reads", () => {
    const f = "components/ClubTotal.vue";
    const links = all("dispatch:store-watch");
    expect(links).toEqual(expect.arrayContaining([
      `composables/useClubs.js::load --clubs--> ${f}::<watch@6>`,
      `composables/useClubs.js::load --clubs--> ${f}::<watch@7>`,
      // `visible` also reads the filter, a ref only the composable holds
      `composables/useClubs.js::setFilter --filter--> ${f}::<watch@7>`,
      "composables/usePlayers.js::load --players--> components/PlayerTotal.vue::<watch@6>",
    ]));
    // `total` reads the list, never the filter; each composable's watchers answer to its own writes only
    expect(links).not.toContain(`composables/useClubs.js::setFilter --filter--> ${f}::<watch@6>`);
    expect(links.filter((l) => l.includes("usePlayers") && l.includes(f))).toEqual([]);
    expect(links.filter((l) => l.includes("useClubs") && l.includes("PlayerTotal"))).toEqual([]);
  });

  it("joins state each call of a composable creates only to the component that calls the writer, state shared at module level to every watcher", () => {
    const links = all("dispatch:store-watch");
    // `ClubBadge` has its own `useClubs()` state and never calls `load`
    expect(links.filter((l) => l.includes("ClubBadge"))).toEqual([]);
    // `user` lives at module level: a login anywhere runs the menu's watcher
    expect(links).toContain("composables/useSession.js::login --user--> components/SessionMenu.vue::<watch@6>");
  });
});
