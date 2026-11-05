import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractFunctions } from "../../functions-classes/index.js";
import { extractImports } from "../../imports-exports/index.js";
import { extractTopLevelCalls } from "../../shared/call-graph.js";
import { extractStoreModules, VuexDispatchResolver } from "./vuex.js";
import type { FileAnalysis, SymbolLink } from "../../../types/analysis.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";

async function project(files: Record<string, string>): Promise<FileAnalysis[]> {
  const out: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, "typescript" as never, filePath);
    const functions = extractFunctions(tree, src, "typescript" as never);
    const top = extractTopLevelCalls(tree, "typescript" as never);
    if (top.length) functions.unshift({ name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: top, line: 1, endLine: 1 });
    const storeModules = extractStoreModules(tree, src);
    out.push({
      filePath, language: "typescript", projectId: "root", exports: [], classes: [],
      imports: extractImports(tree, src, "typescript" as never), functions,
      ...(storeModules.length ? { storeModules } : {}),
    } as unknown as FileAnalysis);
  }
  return out;
}

const FILES = {
  "store/index.js": `import { createStore } from 'vuex';
import contacts from './modules/contacts';
import articles from './modules/helpCenterArticles';
export default createStore({ modules: { contacts, articles } });`,
  "store/modules/contacts/index.js": `import { actions } from './actions';
export default { namespaced: true, state: {}, actions };`,
  "store/modules/contacts/actions.js": `import ContactAPI from '../../../api/contacts';
export const actions = {
  get: async ({ commit }) => { const r = await ContactAPI.get(); commit('SET', r); },
  update: async ({ commit }, c) => { await ContactAPI.update(c.id, c); },
};`,
  "store/modules/helpCenterArticles.js": `const actions = { index: async () => ArticlesAPI.list() };
export default { namespaced: true, state: {}, actions };`,
  "pages/Contacts.vue.ts": `import { useStore } from 'vuex';
const store = useStore();
store.dispatch('contacts/get');
const onSave = (c) => { store.dispatch('contacts/update', c); store.dispatch('articles/index'); store.dispatch('missing/none'); };`,
};

describe("vuex-action dispatch", () => {
  it("reads module registrations from createStore and module definitions", async () => {
    const [store] = await project({ "store/index.js": FILES["store/index.js"] });
    expect(store!.storeModules?.map((m) => `${m.name}=${m.ref}`)).toEqual(["contacts=contacts", "articles=articles"]);
  });

  it("joins each keyed dispatch to its module's action, one link per key", async () => {
    const links = new VuexDispatchResolver().resolve(await project(FILES));
    expect(links.map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`)).toEqual([
      "<setup> -dispatch:contacts/get-> store/modules/contacts/actions.js#actions.get",
      "onSave -dispatch:contacts/update-> store/modules/contacts/actions.js#actions.update",
      "onSave -dispatch:articles/index-> store/modules/helpCenterArticles.js#actions.index",
    ]);
  });

  it("joins a method mapActions binds, called as this.x(), like the dispatch it stands for", async () => {
    const files = {
      ...FILES,
      "components/MatchFooter.vue.ts": `import { mapActions } from 'vuex';
export default {
  methods: {
    ...mapActions('contacts', ['get', 'missing']),
    ...mapActions('articles', { listArticles: 'index' }),
    ...mapActions(['contacts/update']),
    async save() { await this.get(); this.listArticles(); this.missing(); this.other(); },
  },
};`,
    };
    const links = new VuexDispatchResolver().resolve(await project(files));
    expect(links.filter((l) => l.sourceFile.startsWith("components/")).map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetSymbol}`)).toEqual([
      "save -dispatch:contacts/get-> actions.get",
      "save -dispatch:articles/index-> actions.index",
    ]);
  });
});

/** Every file through the real per-file pipeline, so each hook's facts are there. */
async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "vuex-"));
  const out = await mkdtemp(join(tmpdir(), "vuex-out-"));
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  const analyses: FileAnalysis[] = [];
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "javascript" },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

const show = (links: SymbolLink[], from: string) =>
  links.filter((l) => l.sourceFile === from).map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}${l.viaType ? ` (on ${l.viaType})` : ""}`);

const FACTORY = {
  "src/api/ApiClient.js": `class ApiClient {
  constructor(resource) { this.resource = resource; }
  get url() { return '/api/v2/' + this.resource; }
  get() { return axios.get(this.url); }
  update(id, data) { return axios.patch(this.url + '/' + id, data); }
}
export default ApiClient;`,
  "src/api/clubs.js": `import ApiClient from './ApiClient';
class Clubs extends ApiClient {
  constructor() { super('clubs'); }
  transfer(id) { return axios.post(this.url + '/' + id + '/transfer'); }
}
export default new Clubs();`,
  "src/store/factoryHelpers.js": `export const getRecords = (types, API) => async ({ commit }) => {
  const response = await API.get();
  commit(types.SET, response.data);
};
export const updateRecord = (types, API) => async ({ commit }, { id, ...data }) => {
  const response = await API.update(id, data);
  commit(types.EDIT, response.data);
};`,
  "src/store/factory.js": `import { defineStore } from 'pinia';
import { getRecords, updateRecord } from './factoryHelpers';
const makeTypes = name => ({ SET: 'SET_' + name, EDIT: 'EDIT_' + name });
export const crudActions = (API, types) => ({
  get: getRecords(types, API),
  update: updateRecord(types, API),
});
export const createVuexModule = options => {
  const { name, API, actions } = options;
  const types = makeTypes(name);
  const extra = actions ? actions(types) : {};
  return {
    namespaced: true,
    state: {},
    actions: { ...crudActions(API, types), ...extra },
  };
};
export const createPiniaModule = options => defineStore(options.name, { actions: {} });
export const createStore = options => {
  const { type = 'vuex' } = options;
  if (type === 'pinia') return createPiniaModule(options);
  return createVuexModule(options);
};`,
  "src/store/modules/clubs.js": `import ClubsAPI from '../../api/clubs';
import { createStore } from '../factory';
export default createStore({ name: 'Club', API: ClubsAPI });`,
  "src/store/modules/players.js": `import ClubsAPI from '../../api/clubs';
import { createStore } from '../factory';
export default createStore({
  name: 'Player',
  API: ClubsAPI,
  actions: types => ({
    get: async ({ commit }) => { commit(types.SET, []); },
    transfer: async ({ commit }, id) => {
      await ClubsAPI.transfer(id);
    },
  }),
});`,
  "src/store/index.js": `import { createStore } from 'vuex';
import clubs from './modules/clubs';
import players from './modules/players';
export default createStore({ modules: { clubs, players } });`,
  "src/pages/ClubPage.js": `import { useStore } from 'vuex';
const store = useStore();
export const save = club => store.dispatch('clubs/update', club);
export const load = () => store.dispatch('clubs/get');
export const loadPlayers = () => store.dispatch('players/get');
export const editPlayer = p => store.dispatch('players/update', p);
export const transferPlayer = id => store.dispatch('players/transfer', id);`,
};

describe("vuex-action dispatch into a module a project factory builds", () => {
  it("reads the module's factory call and the factory functions' returns", async () => {
    const analyses = await analyzeAll(FACTORY);
    const at = (p: string) => analyses.find((a) => a.filePath === p)!;
    expect(at("src/store/modules/clubs.js").storeShapes?.values?.default).toBeDefined();
    expect(Object.keys(at("src/store/factory.js").storeShapes?.functions ?? {}).sort()).toEqual(["createPiniaModule", "createStore", "createVuexModule", "crudActions", "makeTypes"]);
  });

  it("runs the helper the factory's action calls, on the API class the module passes", async () => {
    const links = new VuexDispatchResolver().resolve(await analyzeAll(FACTORY));
    expect(show(links, "src/pages/ClubPage.js")).toEqual([
      "save -dispatch:clubs/update-> src/store/factoryHelpers.js#updateRecord",
      "save -dispatch:clubs/update-> src/api/ApiClient.js#ApiClient.update (on Clubs)",
      "load -dispatch:clubs/get-> src/store/factoryHelpers.js#getRecords",
      "load -dispatch:clubs/get-> src/api/ApiClient.js#ApiClient.get (on Clubs)",
      // `players` overrides `get` with its own action: never the factory's.
      "editPlayer -dispatch:players/update-> src/store/factoryHelpers.js#updateRecord",
      "editPlayer -dispatch:players/update-> src/api/ApiClient.js#ApiClient.update (on Clubs)",
      // An action written in place in the factory call is no function of its own: the methods it calls.
      "transferPlayer -dispatch:players/transfer-> src/api/clubs.js#Clubs.transfer",
    ]);
  });
});

describe("vuex-action dispatch without a namespace", () => {
  it("skips a module declaring namespaced: true, whose actions are never global", async () => {
    const links = new VuexDispatchResolver().resolve(await analyzeAll({
      "src/store/index.js": `import { createStore } from 'vuex';
import auth from './modules/auth';
import players from './modules/players';
export default createStore({ modules: { auth, players } });`,
      "src/store/modules/auth.js": `const actions = { deleteAvatar: async ({ commit }) => { commit('CLEAR'); } };
export default { state: {}, actions };`,
      "src/store/modules/players.js": `const actions = { deleteAvatar: async ({ commit }, id) => { commit('CLEAR', id); } };
export default { namespaced: true, state: {}, actions };`,
      "src/pages/Profile.js": `import { useStore } from 'vuex';
const store = useStore();
export const remove = () => store.dispatch('deleteAvatar');`,
    }));
    expect(show(links, "src/pages/Profile.js")).toEqual(["remove -dispatch:deleteAvatar-> src/store/modules/auth.js#actions.deleteAvatar"]);
  });
});

/** Two apps, each mounting its own root store, both registering `contacts`. */
const TWO_APPS = {
  "src/entrypoints/dashboard.js": `import { createApp } from 'vue';
import store from '../dashboard/store';
import App from '../dashboard/App';
createApp(App).use(store).mount('#app');`,
  "src/entrypoints/widget.js": `import { createApp } from 'vue';
import store from '../widget/store';
import App from '../widget/App';
createApp(App).use(store).mount('#widget');`,
  "src/dashboard/App.js": `import ContactsPage from './pages/ContactsPage';
export default { components: { ContactsPage } };`,
  "src/widget/App.js": `import { useStore } from 'vuex';
const store = useStore();
export const refresh = () => store.dispatch('contacts/update');`,
  "src/dashboard/store/index.js": `import { createStore } from 'vuex';
import contacts from './modules/contacts';
import conversations from './modules/conversations';
export default createStore({ modules: { contacts, conversations } });`,
  "src/dashboard/store/modules/contacts.js": `const actions = { update: async ({ commit }, c) => { commit('EDIT', c); } };
export default { namespaced: true, state: {}, actions };`,
  "src/dashboard/store/modules/conversations/index.js": `import actions from './actions';
export default { namespaced: true, state: {}, actions };`,
  "src/dashboard/store/modules/conversations/actions.js": `const actions = {
  send: async ({ dispatch }, m) => { await dispatch('sendWithData', m); },
  sendWithData: async ({ commit }, m) => { commit('ADD', m); },
  refreshContact: async ({ dispatch }, c) => { await dispatch('contacts/update', c, { root: true }); },
};
export default actions;`,
  "src/widget/store/index.js": `import { createStore } from 'vuex';
import contacts from './modules/contacts';
import conversation from './modules/conversation';
export default createStore({ modules: { contacts, conversation } });`,
  "src/widget/store/modules/contacts.js": `const actions = { update: async ({ commit }, c) => { commit('SET', c); } };
export default { namespaced: true, state: {}, actions };`,
  "src/widget/store/modules/conversation.js": `const actions = { sendWithData: async ({ commit }, m) => { commit('PUSH', m); } };
export default { namespaced: true, state: {}, actions };`,
  "src/dashboard/pages/ContactsPage.js": `import { useStore } from 'vuex';
const store = useStore();
export const save = c => store.dispatch('contacts/update', c);`,
  // Reached by no app's imports: the store of the app directory it sits in.
  "src/dashboard/components/ContactCard.js": `import { useStore } from 'vuex';
const store = useStore();
export const save = c => store.dispatch('contacts/update', c);`,
};

describe("vuex-action dispatch with several root stores", () => {
  it("joins the root store the caller's app mounts, else the one of its app directory", async () => {
    const links = new VuexDispatchResolver().resolve(await analyzeAll(TWO_APPS));
    expect([...show(links, "src/dashboard/pages/ContactsPage.js"), ...show(links, "src/dashboard/components/ContactCard.js"), ...show(links, "src/widget/App.js")]).toEqual([
      "save -dispatch:contacts/update-> src/dashboard/store/modules/contacts.js#actions.update",
      "save -dispatch:contacts/update-> src/dashboard/store/modules/contacts.js#actions.update",
      "refresh -dispatch:contacts/update-> src/widget/store/modules/contacts.js#actions.update",
    ]);
  });

  it("joins an action context's dispatch inside a module to the module's own action first", async () => {
    const links = new VuexDispatchResolver().resolve(await analyzeAll(TWO_APPS));
    expect(show(links, "src/dashboard/store/modules/conversations/actions.js")).toEqual([
      "actions.send -dispatch:sendWithData-> src/dashboard/store/modules/conversations/actions.js#actions.sendWithData",
      // `{ root: true }`: the global name, in the store of the module's app.
      "actions.refreshContact -dispatch:contacts/update-> src/dashboard/store/modules/contacts.js#actions.update",
    ]);
  });
});

describe("vuex-action dispatch from the root store's own imports", () => {
  it("reads a module's actions in the module, never in the root store that imports it", async () => {
    const links = new VuexDispatchResolver().resolve(await analyzeAll({
      "src/store/index.js": `import { createStore } from 'vuex';
import auth from './modules/auth';
import bots from './modules/bots';
export default createStore({ modules: { auth, bots } });`,
      "src/store/modules/auth.js": `export const actions = { resetToken: async ({ commit }) => { commit('RESET'); } };
export default { state: {}, actions };`,
      "src/store/modules/bots.js": `export const actions = { resetToken: async ({ commit }, id) => { commit('RESET_BOT', id); } };
export default { namespaced: true, state: {}, actions };`,
      "src/pages/Profile.js": `import { useStore } from 'vuex';
const store = useStore();
export const reset = () => store.dispatch('resetToken');`,
    }));
    expect(show(links, "src/pages/Profile.js")).toEqual(["reset -dispatch:resetToken-> src/store/modules/auth.js#actions.resetToken"]);
  });
});
