import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractFunctions } from "../../functions-classes/index.js";
import { extractImports } from "../../imports-exports/index.js";
import { extractTopLevelCalls } from "../../shared/call-graph.js";
import { extractStoreModules, VuexDispatchResolver } from "./vuex.js";
import type { FileAnalysis } from "../../../types/analysis.js";

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
