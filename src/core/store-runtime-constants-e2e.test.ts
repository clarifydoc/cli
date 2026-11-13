import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { SymbolLink } from "../types/analysis.js";

/**
 * A Vuex action named by a constant another module declares (`dispatch(ACTIONS.FETCH_CLUBS)`, `types.ACTIONS.X`,
 * a name re-exported through a barrel), the action keyed by the same constant (`[ACTIONS.FETCH_CLUBS]() {…}`),
 * and a record of composable stores indexed by a prop whose users bind an enum member or a literal. A second
 * `types` module declares the same names with other values, and a decoy store keys its action by it.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", vuex: "4.1.0", axios: "1.6.0" } }),
  "src/main.js": "import { createApp } from 'vue';\nimport App from './App.vue';\nimport store from './store';\ncreateApp(App).use(store).mount('#app');\n",
  "src/App.vue": "<template>\n  <ClubPage />\n  <DeskPage />\n</template>\n<script setup>\nimport ClubPage from './pages/ClubPage.vue';\nimport DeskPage from './pages/DeskPage.vue';\n</script>\n",
  "src/store/index.js": "import { createStore } from 'vuex';\nimport clubs from './modules/clubs';\nimport players from './modules/players';\nimport staff from './modules/staff';\nimport decoy from './modules/decoy';\nexport default createStore({ modules: { clubs, players, staff, decoy } });\n",
  "src/store/types.js": "export const ACTIONS = { FETCH_CLUBS: 'clubs/fetchAll', FETCH_PLAYERS: 'players/fetchAll' };\nexport const LOAD_STAFF = 'staff/load';\n",
  "src/store/barrel.js": "export * from './types';\n",
  "src/other/types.js": "export const ACTIONS = { FETCH_CLUBS: 'decoy/fetchAll', FETCH_PLAYERS: 'decoy/fetchPlayers' };\nexport const LOAD_STAFF = 'decoy/load';\n",
  "src/components/ClubList.vue": [
    "<template>",
    '  <button @click="go">Go</button>',
    '  <button @click="staff">Staff</button>',
    "</template>",
    "<script>",
    "import { ACTIONS } from '../store/types';",
    "import { LOAD_STAFF } from '../store/barrel';",
    "export default {",
    "  methods: {",
    "    go() { this.$store.dispatch(ACTIONS.FETCH_CLUBS); },",
    "    staff() { this.$store.dispatch(LOAD_STAFF); },",
    "  },",
    "};",
    "</script>",
  ].join("\n"),
  "src/components/PlayerList.vue": [
    "<template>",
    '  <button @click="go">Go</button>',
    "</template>",
    "<script setup>",
    "import { useStore } from 'vuex';",
    "import * as types from '../store/types';",
    "const store = useStore();",
    "function go() { store.dispatch(types.ACTIONS.FETCH_PLAYERS); }",
    "</script>",
  ].join("\n"),
  "src/pages/ClubPage.vue": "<template>\n  <ClubList />\n  <PlayerList />\n</template>\n<script setup>\nimport ClubList from '../components/ClubList.vue';\nimport PlayerList from '../components/PlayerList.vue';\n</script>\n",
  "src/composables/kinds.ts": "export enum Kind {\n  Club = 'club',\n  Player = 'player',\n  Coach = 'coach',\n}\n",
  "src/components/Picker.vue": [
    "<template>",
    '  <button @click="add">Add</button>',
    "</template>",
    '<script setup lang="ts">',
    "import { useClubStore } from '../composables/use-club-store';",
    "import { usePlayerStore } from '../composables/use-player-store';",
    "import { Kind } from '../composables/kinds';",
    "const props = defineProps<{ kind: Kind }>();",
    "const stores = {",
    "  [Kind.Club]: useClubStore(),",
    "  [Kind.Player]: usePlayerStore(),",
    "};",
    "async function add() {",
    "  await stores[props.kind].actions.createOne({ name: 'Rovers' });",
    "}",
    "</script>",
  ].join("\n"),
  "src/pages/DeskPage.vue": [
    "<template>",
    "  <Picker",
    '    :kind="Kind.Club"',
    "  />",
    '  <Picker kind="coach" />',
    "</template>",
    "<script setup>",
    "import Picker from '../components/Picker.vue';",
    "import { Kind } from '../composables/kinds';",
    "</script>",
  ].join("\n"),
};
for (const [m, key] of [["clubs", "[ACTIONS.FETCH_CLUBS]"], ["players", "[ACTIONS.FETCH_PLAYERS]"], ["staff", "[LOAD_STAFF]"], ["decoy", "[ACTIONS.FETCH_CLUBS]"]] as const) {
  FILES[`src/store/modules/${m}.js`] = [
    "import axios from 'axios';",
    m === "decoy" ? "import { ACTIONS } from '../../other/types';" : "import { ACTIONS, LOAD_STAFF } from '../types';",
    "export default {",
    "  actions: {",
    `    ${key}() { return axios.get('/api/v2/${m}'); },`,
    "  },",
    "};",
  ].join("\n");
}
for (const s of ["Club", "Player", "Coach"]) {
  const l = s.toLowerCase();
  FILES[`src/composables/use-${l}-store.ts`] = [
    "import axios from 'axios';",
    `export const use${s}Store = function () {`,
    "  const actions = {",
    `    async createOne(body: { name: string }) { return axios.post('/api/v2/${l}s', body); },`,
    "  };",
    "  return { actions };",
    "};",
  ].join("\n");
}

describe("a store action named by an imported constant, and a store picked by a bound kind, end to end", () => {
  let dir: string;
  let links: SymbolLink[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-store-constants-"));
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

  it("joins `dispatch(ACTIONS.X)` of an imported map to the action keyed by the same constant, never the namesake's", () => {
    expect(from("src/components/ClubList.vue", "go")).toEqual(["src/store/modules/clubs.js#actions.[ACTIONS.FETCH_CLUBS] INFERRED"]);
  });

  it("follows a constant through a barrel re-export and a namespace import", () => {
    expect(from("src/components/ClubList.vue", "staff")).toEqual(["src/store/modules/staff.js#actions.[LOAD_STAFF] INFERRED"]);
    expect(from("src/components/PlayerList.vue", "go")).toEqual(["src/store/modules/players.js#actions.[ACTIONS.FETCH_PLAYERS] INFERRED"]);
  });

  it("reaches the one store whose key a user binds to an enum member, kept to that binding", () => {
    // `:kind="Kind.Club"` on the tag at DeskPage line 2; `kind="coach"` names no store the record holds.
    expect(
      links
        .filter((l) => l.sourceFile === "src/components/Picker.vue" && l.sourceSymbol === "add" && l.callName === "stores[].actions.createOne")
        .map((l) => `${l.targetFile}#${l.targetSymbol} via ${(l.viaUsage ?? []).map((u) => `${u.file}:${u.line}`).join(",")}`),
    ).toEqual(["src/composables/use-club-store.ts#actions.createOne via src/pages/DeskPage.vue:2"]);
  });
});
