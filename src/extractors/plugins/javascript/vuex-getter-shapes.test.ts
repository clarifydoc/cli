import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * The Vuex getter shapes a mutation reaches the code watching them, and a mutation table spread two levels deep. Labels are
 * written by hand from the sources below. A `players` module holds the same getter and mutation names as `clubs` and must never
 * answer a `clubs` watcher; a `cups` module imports the table helper but spreads none of it; two modules of `garage` that are not
 * namespaced both hold a getter `standings`, which Vuex itself rejects, so nothing is joined.
 */
const SFC = (script: string) => `<template><div /></template>\n${script}\n`;
const FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", vuex: "^4.0.0" } }),
  "web/src/main.js": `import { createApp } from 'vue'
import App from './App.vue'
import store from './store'
createApp(App).use(store).mount('#app')
`,
  "web/src/App.vue": `<template><div><MapGet /><MapGetObj /><OptGetter /><Doubled /><Scoped /><Standings /><Spread /><CupSpread /><PlayerPanel /><Clicks /></div></template>
<script>
import MapGet from './components/MapGet.vue'
import MapGetObj from './components/MapGetObj.vue'
import OptGetter from './components/OptGetter.vue'
import Doubled from './components/Doubled.vue'
import Scoped from './components/Scoped.vue'
import Standings from './components/Standings.vue'
import Spread from './components/Spread.vue'
import CupSpread from './components/CupSpread.vue'
import PlayerPanel from './components/PlayerPanel.vue'
import Clicks from './components/Clicks.vue'
export default { components: { MapGet, MapGetObj, OptGetter, Doubled, Scoped, Standings, Spread, CupSpread, PlayerPanel, Clicks } }
</script>
`,
  "web/src/store/index.js": `import { createStore } from 'vuex'
import clubs from './clubs'
import players from './players'
import season from './season'
import league from './league'
import fixtures from './fixtures'
import cups from './cups'
export default createStore({ modules: { clubs, players, season, league, fixtures, cups } })
`,
  "web/src/store/clubs.js": `export default {
  namespaced: true,
  state: () => ({ list: [] }),
  getters: {
    total: (state) => state.list.length,
    doubled: (state, getters) => getters.total * 2,
    scoped: (state, getters, rootState) => rootState.season.year + 1,
  },
  mutations: { SET_LIST(state, v) { state.list = v } },
}
`,
  "web/src/store/players.js": `export default {
  namespaced: true,
  state: () => ({ list: [], year: 0 }),
  getters: {
    total: (state) => state.list.length,
    doubled: (state) => state.list.length * 2,
    scoped: (state) => state.year,
    standings: (state) => state.list,
  },
  mutations: { SET_LIST(state, v) { state.list = v }, SET_YEAR(state, v) { state.year = v } },
}
`,
  "web/src/store/season.js": `export default {
  namespaced: true,
  state: () => ({ year: 2020 }),
  mutations: { SET_YEAR(state, v) { state.year = v } },
}
`,
  "web/src/store/league.js": `export default {
  state: () => ({ table: [] }),
  getters: { standings: (state) => state.table },
  mutations: { SET_TABLE(state, v) { state.table = v } },
}
`,
  "web/src/store/fixtures.js": `import { crudMutations } from './mutation-tables'
export default {
  namespaced: true,
  state: () => ({ round: 0 }),
  mutations: { ...crudMutations },
}
`,
  "web/src/store/cups.js": `import { crudMutations } from './mutation-tables'
export const kept = crudMutations
export default {
  namespaced: true,
  state: () => ({ round: 0 }),
  mutations: { TOUCH(state) { state.round = 1 } },
}
`,
  "web/src/store/mutation-tables.js": `const baseMutations = { SET_ROUND(state, v) { state.round = v } }
export const crudMutations = { ...baseMutations, RESET(state) { state.round = 0 } }
`,
  "web/src/components/MapGet.vue": SFC(`<script>
import { mapGetters } from 'vuex'
export default {
  computed: { ...mapGetters('clubs', ['total']) },
  watch: { total() { this.onTotal() } },
  methods: { onTotal() { console.log('t') } },
}
</script>`),
  "web/src/components/MapGetObj.vue": SFC(`<script>
import { mapGetters } from 'vuex'
export default {
  computed: { ...mapGetters({ clubCount: 'clubs/total' }) },
  watch: { clubCount() { this.onCount() } },
  methods: { onCount() { console.log('c') } },
}
</script>`),
  "web/src/components/OptGetter.vue": SFC(`<script>
export default {
  computed: { clubTotal() { return this.$store.getters['clubs/total'] } },
  watch: { clubTotal() { this.onClubTotal() } },
  methods: { onClubTotal() { console.log('o') } },
}
</script>`),
  "web/src/components/Doubled.vue": SFC(`<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.getters['clubs/doubled'], () => onDoubled())
function onDoubled() { console.log('d') }
</script>`),
  "web/src/components/Scoped.vue": SFC(`<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.getters['clubs/scoped'], () => onScoped())
function onScoped() { console.log('s') }
</script>`),
  "web/src/components/Standings.vue": SFC(`<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.getters.standings, () => onStandings())
function onStandings() { console.log('st') }
</script>`),
  "web/src/components/Spread.vue": SFC(`<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.state.fixtures.round, () => onRound())
function onRound() { console.log('r') }
</script>`),
  "web/src/components/CupSpread.vue": SFC(`<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.state.cups.round, () => onCupRound())
function onCupRound() { console.log('cr') }
</script>`),
  "web/src/components/PlayerPanel.vue": SFC(`<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.getters['players/total'], () => onPlayers())
function onPlayers() { console.log('p') }
</script>`),
  "web/src/components/Clicks.vue": `<template><div><button @click="a">a</button><button @click="b">b</button><button @click="c">c</button><button @click="d">d</button></div></template>
<script setup>
import { useStore } from 'vuex'
const store = useStore()
function a() { store.commit('clubs/SET_LIST', []) }
function b() { store.commit('season/SET_YEAR', 1) }
function c() { store.commit('SET_TABLE', []) }
function d() { store.commit('fixtures/SET_ROUND', 1) }
</script>
`,
  // two modules that are not namespaced, both holding a getter `standings`
  "garage/package.json": JSON.stringify({ name: "garage-web", dependencies: { vue: "^3.4.0", vuex: "^4.0.0" } }),
  "garage/src/main.js": `import { createApp } from 'vue'
import App from './App.vue'
import store from './store'
createApp(App).use(store).mount('#app')
`,
  "garage/src/App.vue": `<template><div><Board /></div></template>
<script>
import Board from './Board.vue'
export default { components: { Board } }
</script>
`,
  "garage/src/store.js": `import { createStore } from 'vuex'
import cars from './cars'
import drivers from './drivers'
export default createStore({ modules: { cars, drivers } })
`,
  "garage/src/cars.js": `export default {
  state: () => ({ rows: [] }),
  getters: { standings: (state) => state.rows },
  mutations: { SET_CARS(state, v) { state.rows = v } },
}
`,
  "garage/src/drivers.js": `export default {
  state: () => ({ rows: [] }),
  getters: { standings: (state) => state.rows },
  mutations: { SET_DRIVERS(state, v) { state.rows = v } },
}
`,
  "garage/src/Board.vue": `<template><button @click="go">go</button></template>
<script setup>
import { watch } from 'vue'
import { useStore } from 'vuex'
const store = useStore()
watch(() => store.getters.standings, () => onStandings())
function onStandings() { console.log('s') }
function go() { store.commit('SET_CARS', []) }
</script>
`,
};

describe("Vuex getters and nested mutation tables", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const all = (strategy: string) =>
    (summary.symbolLinks ?? []).filter((l) => l.strategy === strategy).map((l) => `${l.sourceFile.replace(/\/src\//, "/")}::${l.sourceSymbol} --${l.callName}--> ${l.targetFile.replace(/\/src\//, "/")}::${l.targetSymbol}`);
  const watches = (prefix: string) => all("dispatch:vuex-state-watch").filter((l) => l.startsWith(prefix));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-vuex-getters-"));
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

  it("runs a watcher on a mapGetters computed, an Options this.$store.getters computed and a getter reading getters or rootState", () => {
    const w = watches("web/store/");
    expect(w).toEqual(expect.arrayContaining([
      "web/store/clubs.js::mutations.SET_LIST --list--> web/components/MapGet.vue::total",
      "web/store/clubs.js::mutations.SET_LIST --list--> web/components/MapGetObj.vue::clubCount",
      "web/store/clubs.js::mutations.SET_LIST --list--> web/components/OptGetter.vue::<watch@5>",
      "web/store/clubs.js::mutations.SET_LIST --list--> web/components/Doubled.vue::<watch@6>",
      "web/store/season.js::mutations.SET_YEAR --year--> web/components/Scoped.vue::<watch@6>",
    ]));
  });

  it("never lets the namesake module's getters or mutations answer a clubs watcher", () => {
    const w = watches("web/store/");
    expect(w.filter((l) => l.includes("players.js"))).toEqual(["web/store/players.js::mutations.SET_LIST --list--> web/components/PlayerPanel.vue::<watch@6>"]);
    // clubs/scoped reads the season's year: the players module's `SET_YEAR` is another year
    expect(w.filter((l) => l.includes("players.js") && l.includes("Scoped"))).toEqual([]);
    expect(w.filter((l) => l.includes("PlayerPanel")).length).toBe(1);
  });

  it("answers a bare getter of a module that is not namespaced by that module only", () => {
    expect(watches("web/store/league.js")).toEqual(["web/store/league.js::mutations.SET_TABLE --table--> web/components/Standings.vue::<watch@6>"]);
    expect(watches("web/store/players.js").some((l) => l.includes("Standings"))).toBe(false);
  });

  it("joins a mutation written in a table two spreads away, and its commit", () => {
    expect(all("dispatch:vuex-action")).toContain("web/components/Clicks.vue::d --commit:fixtures/SET_ROUND--> web/store/mutation-tables.js::baseMutations.SET_ROUND");
    expect(watches("web/store/mutation-tables.js")).toEqual(expect.arrayContaining([
      "web/store/mutation-tables.js::baseMutations.SET_ROUND --round--> web/components/Spread.vue::<watch@6>",
      "web/store/mutation-tables.js::crudMutations.RESET --round--> web/components/Spread.vue::<watch@6>",
    ]));
  });

  it("gives the nested table to the module that spreads it, not to one that only imports its file", () => {
    expect(watches("web/store/mutation-tables.js").filter((l) => l.includes("CupSpread"))).toEqual([]);
    expect(watches("web/store/cups.js")).toEqual(["web/store/cups.js::mutations.TOUCH --round--> web/components/CupSpread.vue::<watch@6>"]);
  });

  it("joins nothing for a getter two modules that are not namespaced both hold", () => {
    expect(watches("garage/")).toEqual([]);
  });
});
