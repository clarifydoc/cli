import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";

/**
 * A call on what a project's own factory returned (composable, hook, store factory): it names one of the
 * members the factory returns — an object literal's method, a returned function, a store action — or
 * nothing. It never lands on the factory itself, and an Array builtin on a returned plain value
 * (`items.toReversed()`) is no call of the project's. (real-repo FP: 76 and 758 `factory-via` rows.)
 */
describe("calls on a project factory's result", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-factory-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league-web","dependencies":{"vue":"3.4.0"}}');
    await file(
      "src/composables/use-clubs.ts",
      [
        'import { ref } from "vue";',
        "export function useClubs() {",
        "  const items = ref<string[]>([]);",
        '  async function load() { await fetch("/api/v2/clubs"); }',
        "  const actions = {",
        "    async refresh() { await load(); },",
        '    async rename() { await fetch("/api/v2/clubs/rename"); },',
        "  };",
        "  return { items, actions, load };",
        "}",
        "",
      ].join("\n"),
    );
    await file("src/composables/use-cars.ts", "export function useCars() {\n  const cars = [] as string[];\n  return { cars };\n}\n");
    await file(
      "src/pages/Clubs.vue",
      [
        '<script setup lang="ts">',
        'import { useClubs } from "../composables/use-clubs";',
        'import { useCars } from "../composables/use-cars";',
        "const { items, actions: clubActions, load } = useClubs();",
        "const { cars } = useCars();",
        "const newest = items.value.toReversed();",
        "const reversed = cars.toReversed();",
        "function onGo() { clubActions.refresh(); clubActions.rename(); load(); clubActions.vanish(); }",
        "</script>",
        '<template><button @click="onGo">go</button></template>',
        "",
      ].join("\n"),
    );
    await file("src/stores/create-store.ts", "export function createStore(def: any) { return () => def; }\n");
    await file(
      "src/stores/players.ts",
      [
        'import { createStore } from "./create-store";',
        "export const usePlayersStore = createStore({",
        "  actions: () => ({",
        '    get(id: string) { return fetch(`/api/v2/players/${id}`); },',
        '    search(q: string) { return fetch(`/api/v2/players?q=${q}`); },',
        "  }),",
        "});",
        "",
      ].join("\n"),
    );
    await file(
      "src/pages/Players.vue",
      [
        '<script setup lang="ts">',
        'import { usePlayersStore } from "../stores/players";',
        "const playersStore = usePlayersStore();",
        'function load() { playersStore.get("1"); playersStore.search("x"); }',
        "</script>",
        '<template><button @click="load">load</button></template>',
        "",
      ].join("\n"),
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksOf = async (source: string) => {
    const { loadReportSummary } = await import("./report-payload.js");
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    return (summary.symbolLinks ?? []).filter((l) => l.sourceFile === source && l.relation !== "reference");
  };

  it("resolves a method of the returned object literal, and drops what the factory does not return", async () => {
    const links = await linksOf("src/pages/Clubs.vue");
    const row = (l: (typeof links)[number]) => `${l.callName} -> ${l.targetFile.split("/").pop()}::${l.targetSymbol}`;
    const shown = links.map(row);
    expect(shown).toContain("clubActions.refresh -> use-clubs.ts::actions.refresh");
    expect(shown).toContain("clubActions.rename -> use-clubs.ts::actions.rename");
    expect(shown).toContain("load -> use-clubs.ts::load");
    // A method the returned object lacks, and an Array builtin on a returned value: no link, above all not the factory.
    expect(links.filter((l) => l.callName === "clubActions.vanish")).toEqual([]);
    expect(links.filter((l) => /toReversed/.test(l.callName))).toEqual([]);
    expect(links.filter((l) => l.strategy === "factory-via")).toEqual([]);
  });

  it("links a store action by its name, `get` and `search` included, to the action", async () => {
    const links = await linksOf("src/pages/Players.vue");
    const shown = links.filter((l) => l.callName.startsWith("playersStore.")).map((l) => `${l.callName} -> ${l.targetSymbol}`);
    expect(shown.sort()).toEqual(["playersStore.get -> actions.get", "playersStore.search -> actions.search"]);
  });
});

/**
 * A Vuex module a project's `createStore` factory builds from `actions: mutations => ({ k: async function k() {…} })`:
 * each action is a function of its own, so a dispatch lands on the action — not on the module's `<setup>`, whose
 * calls were the API methods the OTHER actions make. (real-repo shape)
 */
describe("dispatch into a module built by a project store factory", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-factory-vuex-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league-web","dependencies":{"vue":"3.4.0","vuex":"4.1.0"}}');
    await file(
      "src/store/storeFactory.js",
      [
        "export const createCrudActions = (API) => ({ get: async () => API.list() });",
        "export const createVuexStore = (options) => {",
        "  const { name, API, actions } = options;",
        "  const customActions = actions ? actions({ name }) : {};",
        "  return { namespaced: true, state: {}, actions: { ...createCrudActions(API), ...customActions } };",
        "};",
        "export const createStore = (options) => createVuexStore(options);",
        "",
      ].join("\n"),
    );
    await file(
      "src/api/transfers.js",
      "class TransfersAPI {\n  create(p) { return axios.post('/api/v2/transfers', p); }\n  sync(p) { return axios.post('/api/v2/transfers/sync', p); }\n}\nexport default new TransfersAPI();\n",
    );
    await file(
      "src/store/modules/transfers.js",
      [
        "import TransfersAPI from '../../api/transfers';",
        "import { createStore } from '../storeFactory';",
        "export default createStore({",
        "  name: 'Transfers',",
        "  API: TransfersAPI,",
        "  actions: (mutations) => ({",
        "    processTransfer: async function processTransfer({ commit }, { ids }) {",
        "      return await TransfersAPI.create({ ids });",
        "    },",
        "    syncTransfers: async function syncTransfers({ dispatch }, { ids }) {",
        "      await dispatch('processTransfer', { ids });",
        "      return TransfersAPI.sync({ ids });",
        "    },",
        "  }),",
        "});",
        "",
      ].join("\n"),
    );
    await file("src/store/index.js", "import { createStore } from 'vuex';\nimport transfers from './modules/transfers';\nexport default createStore({ modules: { transfers } });\n");
    await file(
      "src/pages/Transfers.vue",
      [
        "<script setup>",
        "import { useStore } from 'vuex';",
        "const store = useStore();",
        "const run = async () => { await store.dispatch('transfers/syncTransfers', { ids: [1] }); };",
        "</script>",
        '<template><button @click="run">go</button></template>',
        "",
      ].join("\n"),
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("targets the action, never the module's setup, and the action's own calls stay its own", async () => {
    const { loadReportSummary } = await import("./report-payload.js");
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    const links = (summary.symbolLinks ?? []).filter((l) => l.strategy?.startsWith("dispatch:"));
    const shown = links.map((l) => `${l.sourceFile.split("/").pop()}:${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`);
    expect(shown).toContain("Transfers.vue:run dispatch:transfers/syncTransfers -> actions.syncTransfers");
    expect(shown).toContain("transfers.js:actions.syncTransfers dispatch:processTransfer -> actions.processTransfer");
    // No dispatch ends on the module's own setup, nor on an API method.
    expect(links.filter((l) => l.targetSymbol === "<setup>" || /TransfersAPI/.test(l.targetSymbol))).toEqual([]);
    const own = (summary.symbolLinks ?? []).filter((l) => l.sourceSymbol === "actions.syncTransfers" && l.callName === "TransfersAPI.sync");
    expect(own.length).toBe(1);
  });
});

/**
 * A factory whose returned object spreads another call (`return { setClub, ...useMenu() }`) hands back members its
 * literal does not list: a call naming one of them is not dropped as "not returned". (real-repo shape: a Pinia setup
 * store spreading a composable)
 */
describe("a returned object with a spread or a forwarded member", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-factory-spread-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league-web","dependencies":{"vue":"3.4.0","pinia":"2.1.0"}}');
    await file("src/composables/use-backend.ts", "export function useBackend() {\n  async function signIn() { return fetch('/api/v2/session'); }\n  return { signIn };\n}\n");
    await file(
      "src/composables/use-session.ts",
      "import { useBackend } from './use-backend';\nexport function useSession() {\n  const backend = useBackend();\n  return { signIn: backend.signIn };\n}\n",
    );
    await file("src/composables/use-menu.ts", "export function useMenu() {\n  function toggleMenu() { return 1; }\n  return { toggleMenu };\n}\n");
    await file(
      "src/stores/club.ts",
      [
        "import { defineStore } from 'pinia';",
        "import { useMenu } from '../composables/use-menu';",
        "export const useClubStore = defineStore('club', () => {",
        "  function setClub(id: string) { return fetch(`/api/v2/clubs/${id}`); }",
        "  return { setClub, ...useMenu() };",
        "});",
        "",
      ].join("\n"),
    );
    await file(
      "src/pages/Club.vue",
      [
        '<script setup lang="ts">',
        "import { useClubStore } from '../stores/club';",
        "import { useSession } from '../composables/use-session';",
        "const clubStore = useClubStore();",
        "const session = useSession();",
        "function onLogin() { session.signIn(); }",
        "function onMenu() { clubStore.toggleMenu(); }",
        "function onPick() { clubStore.setClub('1'); }",
        "</script>",
        '<template><button @click="onMenu">menu</button><button @click="onPick">pick</button><button @click="onLogin">in</button></template>',
        "",
      ].join("\n"),
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a link for a member the spread hands back", async () => {
    const { loadReportSummary } = await import("./report-payload.js");
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    const links = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "src/pages/Club.vue" && l.relation !== "reference");
    expect(links.some((l) => l.callName === "clubStore.toggleMenu")).toBe(true);
    expect(links.some((l) => l.callName === "clubStore.setClub")).toBe(true);
    // `signIn: backend.signIn` hands on another object's member: the call is not dropped as "not returned".
    expect(links.some((l) => l.callName === "session.signIn")).toBe(true);
  });
});
