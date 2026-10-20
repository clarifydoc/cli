import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { applyAliases, clearTsconfigAliasCache, loadTsconfigAliasesForDir } from "./tsconfig-aliases.js";

describe("tsconfig aliases", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "revdoc-tsconfig-"));
    await mkdir(join(root, "src-ui/src/environments"), { recursive: true });
    await mkdir(join(root, "src-ui/src/app"), { recursive: true });
    await writeFile(
      join(root, "src-ui/tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "./", paths: { "@app/*": ["src/app/*"] } } }),
    );
    await writeFile(join(root, "src-ui/src/environments/environment.ts"), "export const environment = {};");
    clearTsconfigAliasCache();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves a bare import under baseUrl when the file is there (paperless)", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "src-ui/src/app"));
    expect(applyAliases("src/environments/environment", aliases, root)).toBe("src-ui/src/environments/environment");
  });

  it("leaves a package import alone even under baseUrl", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "src-ui/src/app"));
    expect(applyAliases("rxjs/operators", aliases, root)).toBe("rxjs/operators");
    expect(applyAliases("@angular/core", aliases, root)).toBe("@angular/core");
  });

  it("still applies paths aliases first", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "src-ui/src/app"));
    expect(applyAliases("@app/services/x", aliases, root)).toBe("src-ui/src/app/services/x");
  });
});

describe("aliases beyond a plain tsconfig", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "revdoc-aliases-"));
    // A create-vite scaffold: solution-style tsconfig, paths in tsconfig.app.json.
    await mkdir(join(root, "ui/src/utils"), { recursive: true });
    await mkdir(join(root, "ui/console-src"), { recursive: true });
    await writeFile(join(root, "ui/tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] }));
    await writeFile(join(root, "ui/tsconfig.app.json"), `{
  // JSONC, as scaffolds write it
  "compilerOptions": { "paths": { "@/*": ["./src/*"], "@console/*": ["./console-src/*"], } }
}`);
    // TypeScript 5's array `extends`, and a malformed `paths`, must not break anything.
    await writeFile(join(root, "ui/tsconfig.node.json"), JSON.stringify({ extends: ["@tsconfig/node24/tsconfig.json", "./tsconfig.base.json"], compilerOptions: { types: ["node"], paths: { "#x": "not-an-array", "#y": [42] } } }));
    await writeFile(join(root, "ui/tsconfig.base.json"), JSON.stringify({ compilerOptions: { paths: { "#base/*": ["./src/*"] } } }));
    // A Vite config with no tsconfig: object and array forms, plus a package alias.
    await mkdir(join(root, "web/resources/js/components"), { recursive: true });
    await mkdir(join(root, "web/lib"), { recursive: true });
    await writeFile(join(root, "web/vite.config.js"), `import { fileURLToPath, URL } from 'node:url'
import path from 'path'
export default {
  server: { proxy: { '/api': 'http://localhost:8080' } }, // not an alias
  resolve: {
    alias: {
      vue: 'vue/dist/vue.esm.js',
      '@': fileURLToPath(new URL('./resources/js', import.meta.url)),
      '@components': '/resources/js/components',
      '@missing': '/does/not/exist',
    },
  },
  build: { rollupOptions: { alias: [{ find: 'lib', replacement: path.resolve(__dirname, 'lib') }, { find: /^~/, replacement: '' }] } },
}`);
    // Aliases declared in a shared module the config imports (chatwoot).
    await mkdir(join(root, "rails/app/javascript/dashboard"), { recursive: true });
    await writeFile(join(root, "rails/vite.shared.ts"), `import path from 'path';
export const aliases = {
  dashboard: path.resolve('./app/javascript/dashboard'),
};`);
    await writeFile(join(root, "rails/vite.config.ts"), `import { aliases } from './vite.shared';
export default defineConfig({ resolve: { alias: aliases } });`);
    // tsconfig and bundler disagree on `@`: the tsconfig wins.
    await mkdir(join(root, "both/src"), { recursive: true });
    await mkdir(join(root, "both/other"), { recursive: true });
    await writeFile(join(root, "both/tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
    await writeFile(join(root, "both/vite.config.ts"), `export default { resolve: { alias: { '@': '/other', '~': '/other' } } }`);
    // Nuxt: the tsconfig extends a generated `.nuxt/tsconfig.json` a checkout never has.
    await mkdir(join(root, "nuxt4/app/composables"), { recursive: true });
    await writeFile(join(root, "nuxt4/tsconfig.json"), JSON.stringify({ extends: "./.nuxt/tsconfig.json" }));
    await writeFile(join(root, "nuxt4/nuxt.config.ts"), `export default defineNuxtConfig({ future: { compatibilityVersion: 4 } })`);
    await mkdir(join(root, "nuxt3/composables"), { recursive: true });
    await mkdir(join(root, "nuxt3/app"), { recursive: true }); // app/router.options.ts lives here on Nuxt 3
    await writeFile(join(root, "nuxt3/package.json"), JSON.stringify({ devDependencies: { nuxt: "^3.12.0" } }));
    await writeFile(join(root, "nuxt3/nuxt.config.ts"), `export default defineNuxtConfig({})`);
    clearTsconfigAliasCache();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("knows Nuxt's own aliases: ~ and @ are the source directory, ~~ the root", () => {
    const four = loadTsconfigAliasesForDir(join(root, "nuxt4/app/composables"));
    expect(applyAliases("~/composables/api", four, root)).toBe("nuxt4/app/composables/api");
    expect(applyAliases("@/composables/api", four, root)).toBe("nuxt4/app/composables/api");
    expect(applyAliases("~~/server/x", four, root)).toBe("nuxt4/server/x");
    const three = loadTsconfigAliasesForDir(join(root, "nuxt3/composables"));
    expect(applyAliases("~/composables/api", three, root)).toBe("nuxt3/composables/api");
  });

  it("reads the paths of the configs a solution-style tsconfig references", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "ui/src/utils"));
    expect(applyAliases("@/utils/focus", aliases, root)).toBe("ui/src/utils/focus");
    expect(applyAliases("@console/composables/x", aliases, root)).toBe("ui/console-src/composables/x");
    expect(applyAliases("#base/utils/x", aliases, root)).toBe("ui/src/utils/x");
  });

  it("reads a Vite config's literal aliases, keeping only those that point into the project", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "web/resources/js"));
    expect(applyAliases("@/store/index", aliases, root)).toBe("web/resources/js/store/index");
    expect(applyAliases("@components/Button.vue", aliases, root)).toBe("web/resources/js/components/Button.vue");
    expect(applyAliases("lib/format", aliases, root)).toBe("web/lib/format");
    expect(applyAliases("vue", aliases, root)).toBe("vue");
    expect(applyAliases("@missing/x", aliases, root)).toBe("@missing/x");
  });

  it("follows `alias: aliases` into the module the config imports it from", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "rails/app/javascript/dashboard"));
    expect(applyAliases("dashboard/helper/URLHelper.js", aliases, root)).toBe("rails/app/javascript/dashboard/helper/URLHelper.js");
  });

  it("lets the tsconfig win a key both declare; the bundler fills the rest", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "both/src"));
    expect(applyAliases("@/x", aliases, root)).toBe("both/src/x");
    expect(applyAliases("~/y", aliases, root)).toBe("both/other/y");
  });
});

