import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { SymbolLink } from "../types/analysis.js";

/**
 * A store or an action a component picks at run time: a Vuex action named by a prop each user binds to a
 * literal (`store.dispatch(props.fetchKey)` under `<SquadReport fetch-key="squad/fetchPlayers" />`), and a
 * record of composable stores indexed by a prop (`storeMap[props.kind].actions.createOne()`). Each module
 * declares a namesake action (`fetchPlayers`, `createOne`), and a third module nobody names is the decoy.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", vuex: "4.1.0", axios: "1.6.0" } }),
  "src/main.js": "import { createApp } from 'vue';\nimport App from './App.vue';\nimport store from './store';\ncreateApp(App).use(store).mount('#app');\n",
  "src/App.vue": "<template>\n  <SquadPage />\n  <ClubPage />\n</template>\n<script setup>\nimport SquadPage from './pages/SquadPage.vue';\nimport ClubPage from './pages/ClubPage.vue';\n</script>\n",
  "src/store/index.js": "import { createStore } from 'vuex';\nimport squad from './modules/squad';\nimport clubs from './modules/clubs';\nimport players from './modules/players';\nexport default createStore({ modules: { squad, clubs, players } });\n",
  "src/components/SquadReport.vue": [
    "<template>",
    '  <button @click="reload">Reload</button>',
    "</template>",
    "<script setup>",
    "import { useStore } from 'vuex';",
    "const props = defineProps({ fetchKey: { type: String, required: true } });",
    "const store = useStore();",
    "function reload() {",
    "  store.dispatch(props.fetchKey);",
    "}",
    "</script>",
  ].join("\n"),
  "src/components/SquadPanel.vue": [
    "<template>",
    '  <SquadReport :fetch-key="fetchKey" />',
    "</template>",
    "<script setup>",
    "import SquadReport from './SquadReport.vue';",
    "defineProps({ fetchKey: String });",
    "</script>",
  ].join("\n"),
  "src/components/ClubAction.vue": [
    "<template>",
    '  <button @click="run">Run</button>',
    "</template>",
    "<script>",
    "export default {",
    "  props: { actionName: { type: String, default: '' } },",
    "  methods: {",
    "    run() {",
    "      this.$store.dispatch(this.actionName, { name: 'Rovers' });",
    "    },",
    "  },",
    "};",
    "</script>",
  ].join("\n"),
  "src/components/MappedClub.vue": [
    "<template>",
    '  <button @click="save">Save</button>',
    '  <button @click="loadSquad">Squad</button>',
    "</template>",
    "<script>",
    "import { mapActions } from 'vuex';",
    "const ACTIONS = { FETCH_SQUAD: 'squad/fetchPlayers', FETCH_ALL: 'clubs/fetchAll' };",
    "export default {",
    "  methods: {",
    "    ...mapActions(['clubs/update']),",
    "    save() {",
    "      this['clubs/update']({ name: 'United' });",
    "    },",
    "    loadSquad() {",
    "      this.$store.dispatch(ACTIONS.FETCH_SQUAD);",
    "    },",
    "  },",
    "};",
    "</script>",
  ].join("\n"),
  "src/pages/SquadPage.vue": [
    "<template>",
    '  <SquadReport fetch-key="squad/fetchPlayers" />',
    "  <ClubAction :action-name=\"'clubs/update'\" />",
    "  <MappedClub />",
    '  <PlayerPicker kind="player" />',
    "</template>",
    "<script setup>",
    "import SquadReport from '../components/SquadReport.vue';",
    "import ClubAction from '../components/ClubAction.vue';",
    "import MappedClub from '../components/MappedClub.vue';",
    "import PlayerPicker from '../components/PlayerPicker.vue';",
    "</script>",
  ].join("\n"),
  "src/pages/ClubPage.vue": [
    "<template>",
    '  <SquadPanel fetch-key="clubs/fetchPlayers" />',
    "</template>",
    "<script setup>",
    "import SquadPanel from '../components/SquadPanel.vue';",
    "</script>",
  ].join("\n"),
  "src/composables/kinds.ts": "export enum Kind {\n  Club = 'club',\n  Player = 'player',\n  Coach = 'coach',\n}\n",
  "src/components/PlayerPicker.vue": [
    "<template>",
    '  <button @click="createItem">Add</button>',
    '  <button @click="createDirect">Add now</button>',
    '  <button @click="refreshAll">Refresh</button>',
    "</template>",
    '<script setup lang="ts">',
    "import { useClubStore } from '../composables/use-club-store';",
    "import { usePlayerStore } from '../composables/use-player-store';",
    "import { Kind } from '../composables/kinds';",
    "const props = defineProps<{ kind: Kind }>();",
    "const storeMap = {",
    "  [Kind.Club]: useClubStore(),",
    "  [Kind.Player]: usePlayerStore(),",
    "};",
    "async function createItem() {",
    "  const actions = storeMap[props.kind].actions;",
    "  await actions.createOne({ name: 'Rovers' });",
    "}",
    "async function createDirect() {",
    "  await storeMap[props.kind].actions.createOne({ name: 'United' });",
    "}",
    "async function refreshAll() {",
    "  const { actions } = storeMap[props.kind];",
    "  await actions.refresh();",
    "}",
    "</script>",
  ].join("\n"),
};
for (const m of ["squad", "clubs", "players"]) {
  FILES[`src/store/modules/${m}.js`] = [
    "import axios from 'axios';",
    "export default {",
    "  namespaced: true,",
    "  state: { items: [] },",
    "  actions: {",
    `    fetchPlayers() { return axios.get('/api/v2/${m}/players'); },`,
    `    fetchAll() { return axios.get('/api/v2/${m}'); },`,
    `    update(_ctx, body) { return axios.put('/api/v2/${m}/1', body); },`,
    "  },",
    "};",
  ].join("\n");
}
for (const s of ["Club", "Player", "Coach"]) {
  const l = s.toLowerCase();
  FILES[`src/composables/use-${l}-store.ts`] = [
    "import { ref } from 'vue';",
    "import axios from 'axios';",
    "const store = ref([]);",
    `export const use${s}Store = function () {`,
    "  const actions = {",
    `    async createOne(body: { name: string }) { return axios.post('/api/v2/${l}s', body); },`,
    `    async refresh() { store.value = (await axios.get('/api/v2/${l}s')).data; },`,
    "  };",
    "  return { store, actions };",
    "};",
  ].join("\n");
}

describe("a store or action chosen at run time, end to end", () => {
  let dir: string;
  let links: SymbolLink[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-runtime-store-"));
    const root = join(dir, "web");
    for (const [path, src] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), src);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    links = (await loadReportSummary(join(dir, "out"))).symbolLinks ?? [];
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const from = (file: string, symbol: string) =>
    links
      .filter((l) => l.sourceFile === file && l.sourceSymbol === symbol && l.relation !== "reference" && /dispatch/.test(l.strategy ?? ""))
      .map((l) => `${l.targetFile}#${l.targetSymbol} ${l.confidence}${l.viaUsage ? ` via ${l.viaUsage.map((u) => `${u.file}:${u.line}`).join(",")}` : ""}`)
      .sort();

  it("joins a dispatch of a prop to the action each user names, kept to that user's binding", () => {
    expect(from("src/components/SquadReport.vue", "reload")).toEqual([
      // Handed on by SquadPanel's own prop: the binding on SquadReport's tag is the usage.
      "src/store/modules/clubs.js#actions.fetchPlayers INFERRED via src/components/SquadPanel.vue:2",
      "src/store/modules/squad.js#actions.fetchPlayers INFERRED via src/pages/SquadPage.vue:2",
    ]);
  });

  it("reads `this.actionName` of an options component as its prop, bound as a quoted literal", () => {
    expect(from("src/components/ClubAction.vue", "run")).toEqual(["src/store/modules/clubs.js#actions.update INFERRED via src/pages/SquadPage.vue:3"]);
  });

  it("joins `this['clubs/update']()` mapActions bound, and an action named by a constant the file declares", () => {
    expect(from("src/components/MappedClub.vue", "save")).toEqual(["src/store/modules/clubs.js#actions.update INFERRED"]);
    expect(from("src/components/MappedClub.vue", "loadSquad")).toEqual(["src/store/modules/squad.js#actions.fetchPlayers INFERRED"]);
  });

  it("fans a call on a record of stores read at run time out to each store the record holds, never the decoy", () => {
    const both = (member: string) => [`src/composables/use-club-store.ts#actions.${member} INFERRED`, `src/composables/use-player-store.ts#actions.${member} INFERRED`];
    expect(from("src/components/PlayerPicker.vue", "createDirect")).toEqual(both("createOne"));
    expect(from("src/components/PlayerPicker.vue", "createItem")).toEqual(both("createOne"));
    expect(from("src/components/PlayerPicker.vue", "refreshAll")).toEqual(both("refresh"));
  });
});
