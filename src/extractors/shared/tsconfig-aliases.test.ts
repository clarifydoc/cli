import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { applyAliases, clearTsconfigAliasCache, loadTsconfigAliasesForDir } from "./tsconfig-aliases.js";
import { clearWorkspacePackageCache } from "./workspace-packages.js";

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

  it("resolves a bare import under baseUrl when the file is there (real-repo FP)", () => {
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
    // Aliases declared in a shared module the config imports (a real Rails app).
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


describe("tsconfig aliases into a workspace package's build output", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "revdoc-tsconfig-dist-"));
    await mkdir(join(root, "ui/packages/club-client/entry"), { recursive: true });
    await writeFile(join(root, "ui/packages/club-client/package.json"), JSON.stringify({ name: "@league/club-client", main: "./dist/index.js" }));
    await writeFile(join(root, "ui/packages/club-client/entry/index.ts"), "export const clubApiClient = {};");
    // A `src/index` the generator writes, and the bundler's entry that also re-exports it: the entry is the package.
    await mkdir(join(root, "ui/packages/club-client/src"), { recursive: true });
    await writeFile(join(root, "ui/packages/club-client/src/index.ts"), "export * from './api';");
    await writeFile(join(root, "ui/packages/club-client/vite.config.ts"), 'export default { pack: { entry: ["./entry/index.ts"], format: "esm" } };');
    await writeFile(join(root, "ui/tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@league/club-client": ["./packages/club-client/dist/index"] } } }));
    clearTsconfigAliasCache();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the module the build starts from when the tree holds no dist/ (real-repo FP)", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "ui"));
    expect(applyAliases("@league/club-client", aliases, root)).toBe("ui/packages/club-client/entry/index");
  });
});

describe("tsconfig `paths` read as TypeScript reads them", () => {
  let root: string;
  const file = async (path: string, text: string) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "revdoc-tsconfig-paths-"));
    // The longest prefix wins, wherever it is declared; a decoy sits under the shorter one.
    await file("longest/tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"], "@/widgets/*": ["widgets/*"], "@league/sdk": ["sdk/index.ts"] } } }));
    await file("longest/widgets/Gauge.ts", "export function drawGauge() {}");
    await file("longest/src/widgets/Gauge.ts", "export function drawGauge() {}");
    await file("longest/sdk/index.ts", "export const sdk = 1;");
    // Several targets: the first holding a module.
    await file("targets/tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*", "generated/*"], "*": ["types/*", "node_modules/*"] } } }));
    await file("targets/generated/clubApi.ts", "export function fetchClub() {}");
    await file("targets/src/fixtures.ts", "export const fixtures = [];");
    await file("targets/generated/fixtures.ts", "export const fixtures = [];");
    await file("targets/node_modules/axios/index.js", "module.exports = {};");
    // A pattern with a suffix after its `*`.
    await file("suffix/tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "~ui/*.js": ["src/components/*.ts"] } } }));
    await file("suffix/src/components/Button.ts", "export function renderButton() {}");
    // `${configDir}` is the directory of the config being loaded, not of the base declaring it.
    await file("configdir/shared/tsconfig.base.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["${configDir}/src/*"] } } }));
    await file("configdir/shared/src/engine.ts", "export function tuneEngine() {}");
    await file("configdir/app/tsconfig.json", JSON.stringify({ extends: "../shared/tsconfig.base.json" }));
    await file("configdir/app/src/engine.ts", "export function tuneEngine() {}");
    // A base config from a package: a workspace package, or one installed in node_modules.
    await file("workspace/package.json", JSON.stringify({ private: true, workspaces: ["packages/*", "apps/*"] }));
    await file("workspace/packages/tsconfig/package.json", JSON.stringify({ name: "@garage/tsconfig" }));
    await file("workspace/packages/tsconfig/app.json", JSON.stringify({ compilerOptions: { paths: { "~/*": ["${configDir}/lib/*"] } } }));
    await file("workspace/apps/garage/tsconfig.json", JSON.stringify({ extends: "@garage/tsconfig/app.json" }));
    await file("workspace/apps/garage/lib/wash.ts", "export function washCar() {}");
    await file("installed/node_modules/@garage/tsconfig/base.json", JSON.stringify({ compilerOptions: { paths: { "#/*": ["${configDir}/src/*"] } } }));
    await file("installed/tsconfig.json", JSON.stringify({ extends: "@garage/tsconfig/base" }));
    await file("installed/src/pit.ts", "export function pitStop() {}");
    // A config declaring `paths` replaces the base's table wholesale; one declaring none inherits it.
    await file("replace/tsconfig.base.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"], "@shared/*": ["shared/*"] } } }));
    await file("replace/app/tsconfig.json", JSON.stringify({ extends: "../tsconfig.base.json", compilerOptions: { paths: { "~/*": ["lib/*"] } } }));
    await file("replace/app/lib/pit.ts", "export function pitStop() {}");
    await file("replace/shared/tyre.ts", "export function fitTyre() {}");
    await file("replace/inherit/tsconfig.json", JSON.stringify({ extends: "../tsconfig.base.json" }));
    // An array `extends`: the later base's `paths` replace the earlier one's, `baseUrl` of the earlier stays; two bases share a parent.
    await file("bases/tsconfig.root.json", JSON.stringify({ compilerOptions: { baseUrl: "./" } }));
    await file("bases/tsconfig.first.json", JSON.stringify({ extends: "./tsconfig.root.json", compilerOptions: { paths: { "@club/*": ["club/*"] } } }));
    await file("bases/tsconfig.second.json", JSON.stringify({ extends: "./tsconfig.root.json", compilerOptions: { paths: { "@car/*": ["car/*"] } } }));
    await file("bases/app/tsconfig.json", JSON.stringify({ extends: ["../tsconfig.first.json", "../tsconfig.second.json"] }));
    await file("bases/car/garage.ts", "export function park() {}");
    await file("bases/club/match.ts", "export function kickOff() {}");
    clearTsconfigAliasCache();
    clearWorkspacePackageCache();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("replaces a base config's `paths` wholesale when the extending config declares its own", () => {
    const own = loadTsconfigAliasesForDir(join(root, "replace/app"));
    expect(applyAliases("~/pit", own, root)).toBe("replace/app/lib/pit");
    expect(applyAliases("@shared/tyre", own, root)).toBe("@shared/tyre");
    const inherited = loadTsconfigAliasesForDir(join(root, "replace/inherit"));
    expect(applyAliases("@shared/tyre", inherited, root)).toBe("replace/shared/tyre");
  });

  it("lets the later base of an array `extends` replace the earlier one's `paths`", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "bases/app"));
    expect(applyAliases("@car/garage", aliases, root)).toBe("bases/car/garage");
    expect(applyAliases("@club/match", aliases, root)).toBe("@club/match");
  });

  it("takes the pattern with the longest prefix, not the first declared", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "longest/src"));
    expect(applyAliases("@/widgets/Gauge", aliases, root)).toBe("longest/widgets/Gauge");
    expect(applyAliases("@/other/Dial", aliases, root)).toBe("longest/src/other/Dial");
    // A pattern without `*` matches only itself.
    expect(applyAliases("@league/sdk", aliases, root)).toBe("longest/sdk/index.ts");
    expect(applyAliases("@league/sdk/extra", aliases, root)).toBe("@league/sdk/extra");
  });

  it("tries each target in order and keeps the first holding a module", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "targets/src"));
    expect(applyAliases("@/clubApi", aliases, root)).toBe("targets/generated/clubApi");
    expect(applyAliases("@/fixtures", aliases, root)).toBe("targets/src/fixtures");
    // A catch-all pattern leaves an import alone when no target holds it, and an installed package stays a package.
    expect(applyAliases("react", aliases, root)).toBe("react");
    expect(applyAliases("axios", aliases, root)).toBe("axios");
  });

  it("matches a pattern's suffix after the `*`", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "suffix/src"));
    expect(applyAliases("~ui/Button.js", aliases, root)).toBe("suffix/src/components/Button.ts");
    expect(applyAliases("~ui/Button", aliases, root)).toBe("~ui/Button");
  });

  it("reads `${configDir}` as the directory of the config extending the base", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "configdir/app/src"));
    expect(applyAliases("@/engine", aliases, root)).toBe("configdir/app/src/engine");
  });

  it("follows an `extends` naming a package's config", () => {
    const fromWorkspace = loadTsconfigAliasesForDir(join(root, "workspace/apps/garage"));
    expect(applyAliases("~/wash", fromWorkspace, root)).toBe("workspace/apps/garage/lib/wash");
    const installed = loadTsconfigAliasesForDir(join(root, "installed/src"));
    expect(applyAliases("#/pit", installed, root)).toBe("installed/src/pit");
  });
});
