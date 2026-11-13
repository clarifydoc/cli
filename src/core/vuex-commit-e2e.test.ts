import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { SymbolLink } from "../types/analysis.js";

/**
 * A Vuex commit runs the mutation it names, as a dispatch runs an action: by `store.commit('clubs/SET_PAGE')`,
 * a `{ commit }` an action is handed (its own module first), a method `mapMutations` binds, a name built from
 * a constant another module declares (`'clubs/' + types.FETCH`, also for dispatch), a mutation keyed by a
 * constant (`[types.SET_CLUBS]`) and one written in a `new Vuex.Store({ mutations })` call. A second module
 * declares a mutation of the same name, and a `commit` of something else never joins.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "2.7.0", vuex: "3.6.0", axios: "1.6.0" } }),
  "src/main.js": "import Vue from 'vue';\nimport App from './App.vue';\nimport store from './store';\nnew Vue({ store, render: (h) => h(App) }).$mount('#app');\n",
  "src/App.vue": "<template>\n  <ClubPage />\n</template>\n<script>\nimport ClubPage from './ClubPage.vue';\nexport default { components: { ClubPage } };\n</script>\n",
  "src/store/types.js": "export const FETCH_CLUBS = 'fetchClubs';\nexport const SET_CLUBS = 'SET_CLUBS';\nexport const SET_PAGE = 'SET_PAGE';\n",
  "src/store/modules/clubs.js": [
    "import * as types from '../types';",
    "import axios from 'axios';",
    "export default {",
    "  namespaced: true,",
    "  state: { list: [], page: 1 },",
    "  mutations: {",
    "    [types.SET_CLUBS](state, list) { state.list = list; },",
    "    SET_PAGE(state, p) { state.page = p; },",
    "  },",
    "  actions: {",
    "    async [types.FETCH_CLUBS]({ commit }) {",
    "      const r = await axios.get('/api/clubs');",
    "      commit(types.SET_CLUBS, r.data);",
    "      commit('SET_PAGE', 1);",
    "    },",
    "  },",
    "};",
  ].join("\n"),
  "src/store/modules/players.js": "export default {\n  namespaced: true,\n  state: { page: 0 },\n  mutations: { SET_PAGE(state, p) { state.page = p; } },\n  actions: {},\n};\n",
  "src/store/index.js": [
    "import Vue from 'vue';",
    "import Vuex from 'vuex';",
    "import clubs from './modules/clubs';",
    "import players from './modules/players';",
    "export default new Vuex.Store({",
    "  modules: { clubs, players },",
    "  mutations: { RESET(state) { state.ready = false; } },",
    "});",
  ].join("\n"),
  "src/server.js": "const express = require('express');\nconst app = express();\napp.get('/api/clubs', (req, res) => res.json([]));\n",
  "src/ClubPage.vue": [
    "<template>",
    '  <div><button @click="load">Load</button><button @click="goPage">Page</button><button @click="reset">Reset</button><button @click="all">All</button><button @click="note">Note</button></div>',
    "</template>",
    "<script>",
    "import { mapMutations } from 'vuex';",
    "import * as types from './store/types';",
    "import repo from './repo';",
    "export default {",
    "  methods: {",
    "    ...mapMutations('clubs', ['SET_PAGE']),",
    "    load() { this.$store.dispatch('clubs/' + types.FETCH_CLUBS); },",
    "    goPage() { this.SET_PAGE(2); },",
    "    reset() { this.$store.commit('players/SET_PAGE', 0); },",
    "    all() { this.$store.commit('RESET'); },",
    "    note() { repo.commit('clubs/SET_PAGE'); },",
    "  },",
    "};",
    "</script>",
  ].join("\n"),
  "src/repo.js": "export default { commit(name) { return name; } };\n",
};

describe("vuex commit joins its mutation", () => {
  let dir = "";
  let links: SymbolLink[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-vuex-commit-"));
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
      .map((l) => `${l.callName} -> ${l.targetFile}#${l.targetSymbol} ${l.confidence}`)
      .sort();

  it("joins a commit by its namespaced name to that module's mutation, not the namesake's", () => {
    expect(from("src/ClubPage.vue", "reset")).toEqual(["commit:players/SET_PAGE -> src/store/modules/players.js#mutations.SET_PAGE INFERRED"]);
    expect(from("src/ClubPage.vue", "all")).toEqual(["commit:RESET -> src/store/index.js#mutations.RESET INFERRED"]);
  });

  it("joins a method mapMutations binds, called as this.x()", () => {
    expect(from("src/ClubPage.vue", "goPage")).toEqual(["commit:clubs/SET_PAGE -> src/store/modules/clubs.js#mutations.SET_PAGE INFERRED"]);
  });

  it("joins a commit through an action's context in its own module, by literal and by constant", () => {
    expect(from("src/store/modules/clubs.js", "actions.[types.FETCH_CLUBS]")).toEqual([
      "commit:SET_CLUBS -> src/store/modules/clubs.js#mutations.[types.SET_CLUBS] INFERRED",
      "commit:SET_PAGE -> src/store/modules/clubs.js#mutations.SET_PAGE INFERRED",
    ]);
  });

  it("joins a dispatch whose name is built from a constant another module declares", () => {
    expect(from("src/ClubPage.vue", "load")).toEqual(["dispatch:clubs/fetchClubs -> src/store/modules/clubs.js#actions.[types.FETCH_CLUBS] INFERRED"]);
  });

  it("never joins a commit of something that is not the store", () => {
    expect(from("src/ClubPage.vue", "note")).toEqual([]);
  });

  it("does not turn a commit into a data access", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const fns = JSON.stringify(summary.dataAccessGraph ?? {});
    expect(fns).not.toMatch(/commit/);
  });
});
