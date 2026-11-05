import { describe, expect, it } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractAppMount } from "./app-mounts.js";

const mount = async (src: string) => extractAppMount(await parseSource(src, "typescript" as never, "main.ts"), src);

describe("the file that starts a browser app", () => {
  it("is the one mounting the root component with the framework's own call", async () => {
    expect(await mount(`import { createApp } from 'vue'\nimport App from './App.vue'\nimport router from './router'\n\nconst app = createApp(App)\napp.use(router)\napp.mount('#app')\n`)).toEqual({ line: 5 });
    expect(await mount(`import { bootstrapApplication } from '@angular/platform-browser'\nimport { AppComponent } from './app/app.component'\nbootstrapApplication(AppComponent, { providers: [] })\n`)).toEqual({ line: 3 });
    expect(await mount(`import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'\nplatformBrowserDynamic().bootstrapModule(AppModule)\n`)).toEqual({ line: 2 });
    expect(await mount(`import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')!).render(<App />)\n`)).toEqual({ line: 3 });
    expect(await mount(`import ReactDOM from 'react-dom'\nReactDOM.render(<Garage />, document.getElementById('root'))\n`)).toEqual({ line: 2 });
    expect(await mount(`import Vue from 'vue'\nnew Vue({ router, render: (h) => h(App) }).$mount('#app')\n`)).toEqual({ line: 2 });
    expect(await mount(`import { mount } from 'svelte'\nimport App from './App.svelte'\nmount(App, { target: document.body })\n`)).toEqual({ line: 3 });
  });

  it("a Nuxt app's root files start the app though they mount nothing", () => {
    for (const f of ["app.vue", "app/app.vue", "web/app.vue", "layouts/default.vue", "web/layouts/default.vue"]) expect(extractAppMount(undefined as never, "", f), f).toEqual({ line: 1, routed: true });
    for (const f of ["App.vue", "pages/app.vue", "components/app.vue", "layouts/admin.vue", "src/app.ts"]) expect(extractAppMount(undefined as never, "", f), f).toBeUndefined();
  });

  it("a project's own function of that name mounts nothing", async () => {
    expect(await mount(`export const actions = {\n  async createApp({ commit }, club) { commit('add', club) },\n}\n`)).toBeUndefined();
    expect(await mount(`import { render } from '@testing-library/vue'\nrender(ClubCard)\n`)).toBeUndefined();
  });
});
