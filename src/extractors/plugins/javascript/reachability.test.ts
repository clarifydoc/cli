import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterAll } from "vitest";
import { javascriptReachability, globToRegExp } from "./reachability.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A project on disk (manifests are read from it) plus its file list. */
async function model(files: string[], manifests: Record<string, unknown> = {}, subRoots: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-reach-"));
  roots.push(root);
  for (const [path, body] of Object.entries(manifests)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === "string" ? body : JSON.stringify(body));
  }
  return javascriptReachability.load({ projectRoot: root, roots: subRoots, files: new Set(files) });
}

const analysis = (filePath: string, extra: Partial<FileAnalysis> = {}): FileAnalysis =>
  ({ filePath, routes: [], ...extra }) as unknown as FileAnalysis;

describe("JS reachability — module resolution", () => {
  it("probes extensions and index files the way the bundler does", async () => {
    const m = await model(["src/a.ts", "src/b/index.tsx", "src/c.vue", "src/d.ts"]);
    expect(m.resolve("src/main.ts", "./a")).toEqual(["src/a.ts"]);
    expect(m.resolve("src/main.ts", "./b")).toEqual(["src/b/index.tsx"]);
    expect(m.resolve("src/main.ts", "./c.vue?raw")).toEqual(["src/c.vue"]);
    // TS ESM names the emitted file.
    expect(m.resolve("src/main.ts", "./d.js")).toEqual(["src/d.ts"]);
    // A relative path names one place; an asset there is nothing judged.
    expect(m.resolve("src/main.ts", "./styles.css")).toEqual([]);
  });

  it("resolves root-relative paths per project and tsconfig-rewritten paths", async () => {
    const m = await model(["web/src/main.ts", "src/lib/x.ts"], {}, ["web"]);
    expect(m.resolve("web/index.html", "/src/main.ts")).toEqual(["web/src/main.ts"]);
    // `@/lib/x` arrives already rewritten to an analyzed-root-relative path.
    expect(m.resolve("src/app.ts", "src/lib/x")).toEqual(["src/lib/x.ts"]);
  });

  it("treats declared dependencies, builtins and virtual modules as external", async () => {
    const m = await model(["src/react.ts", "src/path.ts"], { "package.json": { dependencies: { react: "^18" } } });
    expect(m.resolve("src/a.ts", "react")).toEqual([]);
    expect(m.resolve("src/a.ts", "node:path")).toEqual([]);
    expect(m.resolve("src/a.ts", "path")).toEqual([]);
    expect(m.resolve("src/a.ts", "virtual:pwa-register")).toEqual([]);
    expect(m.resolve("src/a.ts", "$app/navigation")).toEqual([]);
  });

  it("falls back to every path-suffix match for an alias nobody declared", async () => {
    const m = await model(["src/components/Button.vue", "admin/components/Button.vue", "src/lib/index.ts"]);
    expect(m.resolve("src/a.ts", "@components/Button")).toEqual(["src/components/Button.vue", "admin/components/Button.vue"]);
    expect(m.resolve("src/a.ts", "@/lib")).toEqual(["src/lib/index.ts"]);
    // Surely local, yet names nothing analyzed: an unknown, not "external".
    expect(m.resolve("src/a.ts", "~/missing/thing")).toBeNull();
  });

  it("matches a bundler-rooted path that names its file with the extension (photoprism)", async () => {
    // `overlayResolver({ roots: [src] })`: `component/…` is `frontend/src/component/…`.
    const m = await model(["frontend/src/component/album/edit/dialog.vue", "frontend/src/component/components.js"]);
    expect(m.resolve("frontend/src/component/components.js", "component/album/edit/dialog.vue")).toEqual([
      "frontend/src/component/album/edit/dialog.vue",
    ]);
  });

  it("resolves workspace packages into their own root", async () => {
    const m = await model(
      ["packages/ui/src/index.ts", "packages/ui/src/button.ts", "apps/web/src/main.ts"],
      { "packages/ui/package.json": { name: "@acme/ui", main: "dist/index.js" } },
      ["packages/ui", "apps/web"],
    );
    expect(m.resolve("apps/web/src/main.ts", "@acme/ui")).toEqual(["packages/ui/src/index.ts"]);
    expect(m.resolve("apps/web/src/main.ts", "@acme/ui/button")).toEqual(["packages/ui/src/button.ts"]);
  });
});

describe("JS reachability — entry points", () => {
  it("treats every file under vite_ruby's entrypoints directory as an entry (chatwoot)", async () => {
    const m = await model(
      ["app/javascript/entrypoints/dashboard.js", "app/javascript/entrypoints/v3app.js", "app/javascript/v3/App.vue"],
      { "config/vite.json": { all: { sourceCodeDir: "app/javascript" } } },
    );
    expect(m.manifestEntries).toEqual([
      { file: "app/javascript/entrypoints/dashboard.js", reason: "vite_ruby entrypoint" },
      { file: "app/javascript/entrypoints/v3app.js", reason: "vite_ruby entrypoint" },
    ]);
  });

  it("reads package.json fields and script paths, mapping build output back to source", async () => {
    const m = await model(
      ["src/index.ts", "src/cli.ts", "src/worker.ts", "ops/report.ts", "src/feature/x.ts", "prisma/seed.ts", "test/setup.ts"],
      {
        "package.json": {
          main: "dist/index.js",
          bin: { tool: "./dist/cli.js" },
          exports: { ".": { import: "./dist/index.js" }, "./worker": "./dist/worker.js" },
          scripts: { report: "tsx ops/report.ts --verbose", build: "tsc -p ." },
          prisma: { seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed.ts' },
          jest: { setupFiles: ["<rootDir>/test/setup.ts"] },
        },
      },
    );
    expect(m.manifestEntries).toEqual([
      { file: "ops/report.ts", reason: 'package.json script "report"' },
      { file: "prisma/seed.ts", reason: "package.json prisma" },
      { file: "src/cli.ts", reason: "package.json bin" },
      { file: "src/index.ts", reason: "package.json exports" },
      { file: "src/index.ts", reason: "package.json main" },
      { file: "src/worker.ts", reason: "package.json exports" },
      { file: "test/setup.ts", reason: "package.json jest" },
    ]);
  });

  it("knows tool and framework conventions, gating directory conventions on the framework", async () => {
    const m = await model([]);
    const none = new Set<string>();
    // Run by a tool: alive, never reported, but no evidence of where the program starts.
    expect(m.entryReason(analysis("vite.config.ts"), "vite.config.ts", none)).toBeNull();
    expect(m.passiveReason?.(analysis("vite.config.ts"), "vite.config.ts", none)).toBe("tool config");
    expect(m.passiveReason?.(analysis("src/Button.stories.tsx"), "src/Button.stories.tsx", none)).toBe("Storybook story");
    expect(m.entryReason(analysis("src/main.ts"), "src/main.ts", none)).toBe("conventional entry file");
    expect(m.entryReason(analysis("src/routes/+page.svelte"), "src/routes/+page.svelte", none)).toBe("SvelteKit route module");
    // `pages/` is only an entry directory under a framework that routes by file.
    expect(m.entryReason(analysis("pages/about.tsx"), "pages/about.tsx", none)).toBeNull();
    expect(m.entryReason(analysis("pages/about.tsx"), "pages/about.tsx", new Set(["nextjs"]))).toBe("Next.js page");
    // A file the router generates a route from is its own route component.
    const page = analysis("src/pages/x.vue", {
      routes: [{ path: "/x", httpMethod: null, kind: "frontend", handler: "x", componentPath: null, calls: [], middleware: [], line: 1 }],
    });
    expect(m.entryReason(page, "src/pages/x.vue", none)).toBe("file-based route");
    expect(m.isAmbient?.("src/env.d.ts")).toBe(true);
  });

  it("resolves path references: globs, <rootDir>, bare siblings", async () => {
    const m = await model(["src/pages/a.vue", "src/pages/nested/b.vue", "jest.setup.ts", "electron/preload.js"]);
    expect(m.resolvePath("src/router.ts", "./pages/*.vue")).toEqual(["src/pages/a.vue"]);
    expect(m.resolvePath("src/router.ts", "./pages/**/*.vue")).toEqual(["src/pages/a.vue", "src/pages/nested/b.vue"]);
    expect(m.resolvePath("jest.config.js", "<rootDir>/jest.setup.ts")).toEqual(["jest.setup.ts"]);
    expect(m.resolvePath("electron/main.js", "preload.js")).toEqual(["electron/preload.js"]);
    // A worker spawned from build output is the source file it was built from.
    const w = await model(["core/src/parse-worker.ts", "cli/src/ingest.ts"]);
    expect(w.resolvePath("cli/src/ingest.ts", "../../core/dist/parse-worker.js")).toEqual(["core/src/parse-worker.ts"]);
  });

  it("matches template tags to component files by normalized name", async () => {
    const m = await model(["src/components/UserCard.vue", "src/widgets/date-picker/index.vue", "src/util.ts"]);
    expect(m.resolveTag?.("src/App.vue", "UserCard")).toEqual(["src/components/UserCard.vue"]);
    expect(m.resolveTag?.("src/App.vue", "user-card")).toEqual(["src/components/UserCard.vue"]);
    expect(m.resolveTag?.("src/App.vue", "DatePicker")).toEqual(["src/widgets/date-picker/index.vue"]);
    expect(m.resolveTag?.("src/App.vue", "Util")).toEqual([]);
  });
});

describe("JS reachability — tool-loaded files named by convention or config", () => {
  it("keeps Histoire stories and their setup alive without anchoring them", async () => {
    const m = await model([]);
    const none = new Set<string>();
    expect(m.passiveReason?.(analysis("src/Button.story.vue"), "src/Button.story.vue", none)).toBe("Histoire story");
    expect(m.passiveReason?.(analysis("app/javascript/histoire.setup.ts"), "app/javascript/histoire.setup.ts", none)).toBe("Histoire setup");
  });

  it("anchors the locale files @nuxtjs/i18n loads from langDir (mealie)", async () => {
    const m = await model(
      ["frontend/app/lang/locales/en-US.ts", "frontend/app/lang/locales/da-DK.ts", "frontend/app/lang/locales/unused.ts", "frontend/app/other/en-US.ts"],
      {
        "frontend/nuxt.config.ts": `export default defineNuxtConfig({ i18n: {
          locales: [{ code: "en-US", file: "en-US.ts" }, { code: "da-DK", file: "da-DK.ts" }],
          langDir: "./../app/lang/locales",
        } });`,
      },
      ["frontend"],
    );
    expect(m.manifestEntries).toEqual([
      { file: "frontend/app/lang/locales/da-DK.ts", reason: "nuxt.config.ts i18n locale" },
      { file: "frontend/app/lang/locales/en-US.ts", reason: "nuxt.config.ts i18n locale" },
    ]);
  });
});

describe("globToRegExp", () => {
  it("spans directories only with **, alternates braces", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/x/y/a.ts")).toBe(true);
    expect(globToRegExp("src/*.{vue,ts}").test("src/a.vue")).toBe(true);
    expect(globToRegExp("src/*.{vue,ts}").test("src/a.js")).toBe(false);
  });
});
