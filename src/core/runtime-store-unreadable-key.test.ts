import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { SymbolLink } from "../types/analysis.js";

/**
 * A component dispatches an action its prop names, and its only user binds the prop to a value no name can be read
 * from (`:fetch-key="row.kind"`). The decision: the dispatch stays unlinked — there is no list of every action to
 * fall back to, so the namesake actions of the store modules are decoys no link may reach.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", vuex: "4.1.0", axios: "1.6.0" } }),
  "src/main.js": "import { createApp } from 'vue';\nimport App from './App.vue';\nimport store from './store';\ncreateApp(App).use(store).mount('#app');\n",
  "src/App.vue": "<template>\n  <ClubPage />\n</template>\n<script setup>\nimport ClubPage from './pages/ClubPage.vue';\n</script>\n",
  "src/store/index.js": "import { createStore } from 'vuex';\nimport squad from './modules/squad';\nimport clubs from './modules/clubs';\nexport default createStore({ modules: { squad, clubs } });\n",
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
  "src/pages/ClubPage.vue": [
    "<template>",
    '  <SquadReport v-for="row in rows" :key="row.id" :fetch-key="row.kind" />',
    "</template>",
    "<script setup>",
    "import SquadReport from '../components/SquadReport.vue';",
    "const rows = [];",
    "</script>",
  ].join("\n"),
};
for (const m of ["squad", "clubs"]) {
  FILES[`src/store/modules/${m}.js`] = [
    "import axios from 'axios';",
    "export default {",
    "  namespaced: true,",
    "  actions: {",
    `    fetchPlayers() { return axios.get('/api/v2/${m}/players'); },`,
    "  },",
    "};",
  ].join("\n");
}

describe("a dispatch whose key binding cannot be read", () => {
  let dir: string;
  let links: SymbolLink[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-unread-key-"));
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

  it("links the dispatch to no action", () => {
    const reached = links.filter((l) => l.sourceFile === "src/components/SquadReport.vue" && l.sourceSymbol === "reload" && l.relation !== "reference" && /dispatch/.test(l.strategy ?? ""));
    expect(reached).toEqual([]);
    expect(links.filter((l) => l.targetFile.startsWith("src/store/modules/") && l.sourceFile.startsWith("src/components/"))).toEqual([]);
  });
});
