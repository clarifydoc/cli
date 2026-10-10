import { readFile } from "fs/promises";
import { join } from "path";
import type { FileAnalysis } from "../../../types/analysis.js";
import type {
  ReachabilityHooks,
  ReachabilityLoadContext,
  ReachabilityModel,
} from "../../../types/language-plugin.js";
import { stripJsonc } from "../../shared/tsconfig-aliases.js";
import { findShebangScripts, SCRIPT_DIRS } from "../shared/shebang-scripts.js";

/**
 * How the JS/TS toolchain finds files — the model dead-code analysis
 * (`core/dead-code.ts`) walks to decide what no entry point reaches.
 *
 * Three questions, each answered conservatively (a wrong "reached" only costs
 * a missed finding; a wrong "unreached" is a false accusation):
 *
 *   1. Where does execution start? package.json `main`/`module`/`browser`/
 *      `bin`/`exports` and script paths in `scripts` (mapped from `dist/` back
 *      to `src/`), `wrangler.toml` `main`, `serverless.yml` handlers — plus
 *      files frameworks and tools load by CONVENTION (`*.config.ts`, Next.js
 *      pages, SvelteKit `+page.svelte`, Storybook stories, workers, …).
 *   2. What does an import specifier load? Relative paths with the bundler's
 *      extension/index probing; tsconfig `paths` (already rewritten to
 *      project-relative paths at extraction); workspace packages; known
 *      framework aliases (`$lib`, `@/`, `~/`). An alias nobody declared falls
 *      back to every file whose path ends the same way.
 *   3. Which components render without an import? A template tag is matched
 *      to every component file of that name (auto-imported / globally
 *      registered components).
 */

/** Extensions the bundler probes, in its order. `.d.ts` last: types only. */
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".d.ts"];
const INDEX_FILES = SOURCE_EXTS.map((e) => `/index${e}`);
/** TS ESM imports name the EMITTED file (`./x.js` for `x.ts`). */
const EMITTED_EXT_RE = /\.(?:[cm]?js|jsx)$/;
const TS_EXTS = [".ts", ".tsx", ".mts", ".cts"];
/** Extension stripped when indexing a file by path suffix / component name. */
const STRIP_EXT_RE = /(?:\.d)?\.(?:[cm]?[jt]sx?|vue|svelte)$/;
/** Build output directories a manifest points into instead of the source. */
const OUTPUT_DIRS = new Set(["dist", "lib", "build", "out", "es", "esm", "cjs", "umd", "bundle"]);
const COMPONENT_FILE_RE = /\.(?:vue|svelte|[jt]sx)$/;

/** Specifiers that are never project files: builtins and bundler virtual modules. */
const VIRTUAL_RE = /^(?:node:|virtual:|bun:|deno:|#app\b|#imports\b|#build\b|#components\b|\$app\/|\$env\/|\$service-worker\b|~icons\/|~build\/|vue-router\/auto)/;
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib", "test",
]);

type Rule = readonly [RegExp, string];

/**
 * Where a program starts, by convention, tested against the path relative to
 * the file's own project root. Distinctive conventions only — a pattern that
 * also matches ordinary code would hide real dead code, which is why
 * `pages/`-style directories are gated on their framework below.
 */
const CONVENTION_ENTRIES: readonly Rule[] = [
  [/^(?:src\/)?(?:main|index|server|app|cli)\.[cm]?[jt]sx?$/i, "conventional entry file"],
  [/(?:^|\/)(?:netlify|vercel)\/functions\//, "serverless function"],
  [/^api\//, "serverless function (api/ directory)"],
  // SvelteKit
  [/(?:^|\/)src\/routes\/(?:.*\/)?\+(?:page|layout|server|error)(?:\.server)?\.(?:svelte|[jt]s)$/, "SvelteKit route module"],
  [/(?:^|\/)src\/(?:hooks(?:\.client|\.server)?)(?:\/index)?\.[jt]s$/, "SvelteKit hook"],
  [/(?:^|\/)src\/params\//, "SvelteKit param matcher"],
  // Remix / React Router framework mode
  [/^app\/(?:root|routes|entry\.client|entry\.server)\.[jt]sx?$/, "Remix/React Router entry"],
  // Angular CLI
  [/^src\/(?:main|polyfills)(?:\.server)?\.ts$/, "Angular CLI entry"],
  // Gatsby
  [/^gatsby-(?:node|browser|ssr|config)\.[jt]sx?$/, "Gatsby API file"],
];

/**
 * Files a TOOL runs — configs, stories, mocks, scripts, migrations, workers
 * and service workers the app registers by URL. Never reported, and they keep
 * what they load alive, but none of them says where the program starts.
 */
const TOOL_LOADED: readonly Rule[] = [
  [/(?:^|\/)[^/]+\.config\.[cm]?[jt]s$/, "tool config"],
  [/(?:^|\/)[^/]+\.conf\.[cm]?js$/, "tool config"],
  [/(?:^|\/)\.[\w-]+rc\.[cm]?[jt]s$/, "tool config"],
  [/(?:^|\/)(?:gulpfile|gruntfile|jakefile)(?:\.babel)?\.[cm]?[jt]s$/i, "task-runner file"],
  [/(?:^|\/)\.storybook\//, "Storybook config"],
  [/\.stories\.[cm]?[jt]sx?$/, "Storybook story"],
  [/(?:^|\/)__mocks__\//, "test mock (loaded by the runner)"],
  [/(?:^|\/)(?:setupTests|setupProxy|reportWebVitals)\.[jt]sx?$/, "test/dev-server setup"],
  [/(?:^|\/)(?:jest|vitest|test|global)[.-]?(?:setup|teardown)\.[cm]?[jt]s$/i, "test setup"],
  [/(?:^|\/)(?:service-?worker|sw|registerServiceWorker|serviceWorkerRegistration)\.[jt]s$/i, "service worker"],
  [/\.worker\.[cm]?[jt]s$/, "web worker"],
  [/(?:^|\/)(?:scripts?|bin|tools)\//, "standalone script"],
  [/(?:^|\/)public\//, "static asset (served by URL)"],
  [/(?:^|\/)(?:migrations?|seeds?|seeders)\//, "migration or seed (run by directory)"],
  [/(?:^|\/)preload\.[cm]?[jt]s$/, "Electron preload"],
  [/(?:^|\/)src\/service-worker(?:\/index)?\.[jt]s$/, "SvelteKit service worker"],
  [/^src\/test\.ts$/, "Angular test entry"],
  [/(?:^|\/)environments\/environment[\w.-]*\.ts$/, "Angular environment (swapped by fileReplacements)"],
];

/** Directory conventions only true under their framework. Keyed by framework id. */
const FRAMEWORK_ENTRIES: Readonly<Record<string, readonly Rule[]>> = {
  nextjs: [
    [/^(?:src\/)?pages\//, "Next.js page"],
    [/^(?:src\/)?app\/(?:.*\/)?(?:page|layout|template|loading|error|global-error|not-found|default|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[jt]sx?$/, "Next.js app-router file"],
    [/^(?:src\/)?(?:middleware|instrumentation(?:-client)?)\.[jt]s$/, "Next.js middleware"],
  ],
  nuxt: [
    [/^(?:app\/|src\/)?(?:pages|layouts|middleware|plugins|components|composables|utils|stores|modules|server)\//, "Nuxt auto-registered directory"],
    [/^(?:app\/|src\/)?(?:app|error)\.vue$/, "Nuxt app root"],
  ],
  remix: [[/^app\/routes\//, "Remix route module"]],
  "react-router": [[/^app\/routes\//, "React Router route module"]],
  gatsby: [[/^src\/(?:pages|templates|api)\//, "Gatsby page"]],
  astro: [
    [/^src\/pages\//, "Astro page/endpoint"],
    [/^src\/middleware(?:\/index)?\.[jt]s$/, "Astro middleware"],
  ],
  quasar: [
    [/^src\/boot\//, "Quasar boot file"],
    [/^src-(?:ssr|electron|pwa|bex|capacitor|cordova)\//, "Quasar mode entry"],
    [/^src\/(?:router|store|stores)\/index\.[jt]s$/, "Quasar app wiring"],
  ],
};

export const javascriptReachability: ReachabilityHooks = {
  load: loadJsReachability,
};

interface PackageRoot {
  /** Project root (posix, project-relative; "" = analyzed root). */
  root: string;
  pkg: Record<string, unknown> | null;
}

async function loadJsReachability(ctx: ReachabilityLoadContext): Promise<ReachabilityModel> {
  const files = ctx.files;
  const roots = [...new Set(["", ...ctx.roots])].sort((a, b) => b.length - a.length);
  const rootOf = (file: string): string =>
    roots.find((r) => r === "" || file.startsWith(r + "/")) ?? "";
  const under = (root: string, rel: string): string => normalize(root ? `${root}/${rel}` : rel);

  const packages: PackageRoot[] = [];
  for (const root of roots) {
    packages.push({ root, pkg: await readJson(join(ctx.projectRoot, root, "package.json")) });
  }

  // Dependencies declared anywhere: an import of one is precisely external.
  const declared = new Set<string>();
  // Workspace packages by name: an import of one resolves into the repo.
  const workspace = new Map<string, string>();
  for (const { root, pkg } of packages) {
    if (!pkg) continue;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = pkg[field];
      if (deps && typeof deps === "object") for (const name of Object.keys(deps)) declared.add(name);
    }
    if (typeof pkg.name === "string") workspace.set(pkg.name, root);
  }

  // ── Module resolution ──
  const probe = (base: string): string | null => {
    const b = normalize(base);
    if (files.has(b) && !/\/$/.test(b)) return b;
    for (const ext of SOURCE_EXTS) if (files.has(b + ext)) return b + ext;
    for (const idx of INDEX_FILES) if (files.has(b + idx)) return b + idx;
    const emitted = EMITTED_EXT_RE.exec(b);
    if (emitted) {
      const stem = b.slice(0, emitted.index);
      for (const ext of TS_EXTS) if (files.has(stem + ext)) return stem + ext;
    }
    return null;
  };

  // Path-suffix index for aliases nobody declared: "components/Button" →
  // every file whose extension-less path (or index directory) ends that way.
  const bySuffix = new Map<string, string[]>();
  // Component files by normalized name, for template tags without an import.
  const byComponentName = new Map<string, string[]>();
  for (const f of files) {
    if (!STRIP_EXT_RE.test(f)) continue;
    const stripped = f.replace(STRIP_EXT_RE, "");
    const variants = [stripped];
    if (/(?:^|\/)index$/.test(stripped)) variants.push(stripped.replace(/\/?index$/, ""));
    for (const v of variants) {
      const segs = v.split("/").filter(Boolean);
      for (let i = 0; i < segs.length; i++) push(bySuffix, segs.slice(i).join("/"), f);
    }
    if (COMPONENT_FILE_RE.test(f)) {
      const segs = stripped.split("/");
      let name = segs[segs.length - 1]!;
      if (name === "index" && segs.length > 1) name = segs[segs.length - 2]!;
      push(byComponentName, normTag(name.replace(/\.component$/, "")), f);
    }
  }

  /**
   * `probe`, then — for a path into build output (`dist/x.js`, a worker spawned
   * from `../core/dist/parse-worker.js`) — the source it was built from: the
   * output directory swapped for `src/`, or dropped.
   */
  const probeSource = (base: string): string | null => {
    const hit = probe(base);
    if (hit) return hit;
    const segs = normalize(base).split("/");
    for (let i = 0; i < segs.length - 1; i++) {
      if (!OUTPUT_DIRS.has(segs[i]!)) continue;
      const head = segs.slice(0, i);
      const rest = segs.slice(i + 1);
      const mapped = probe([...head, "src", ...rest].join("/")) ?? probe([...head, ...rest].join("/"));
      if (mapped) return mapped;
    }
    return null;
  };

  const resolveCache = new Map<string, string[] | null>();
  const resolve = (fromFile: string, rawSource: string): string[] | null => {
    const source = rawSource.replace(/[?#].*$/, "");
    if (!source || VIRTUAL_RE.test(source)) return [];
    const dir = dirOf(fromFile);
    const root = rootOf(fromFile);
    const key = `${source.startsWith(".") ? dir : root}\0${source}`;
    const cached = resolveCache.get(key);
    if (cached !== undefined) return cached;
    const result = resolveUncached(source, dir, root);
    resolveCache.set(key, result);
    return result;
  };

  const resolveUncached = (source: string, dir: string, root: string): string[] | null => {
    if (source.startsWith(".")) {
      const hit = probe(dir ? `${dir}/${source}` : source);
      // A relative path names exactly one place; an asset or an excluded
      // file there is simply nothing this analysis judges.
      return hit ? [hit] : [];
    }
    // Absolute: the project root (Vite's `/src/main.ts`).
    if (source.startsWith("/")) {
      const hit = probe(under(root, source.slice(1)));
      return hit ? [hit] : [];
    }

    // tsconfig `paths` were rewritten to analyzed-root-relative paths.
    const direct = probe(source);
    if (direct) return [direct];

    // Framework aliases, relative to the importing file's project root.
    for (const [prefix, targets] of FRAMEWORK_ALIASES) {
      if (source !== prefix && !source.startsWith(prefix + "/")) continue;
      const rest = source.slice(prefix.length).replace(/^\/+/, "");
      for (const t of targets) {
        const hit = probe(under(root, t ? `${t}/${rest}` : rest));
        if (hit) return [hit];
      }
    }

    const segs = source.split("/");
    const pkgName = source.startsWith("@") && segs.length >= 2 ? `${segs[0]}/${segs[1]}` : segs[0]!;
    const subpath = source.slice(pkgName.length).replace(/^\/+/, "");

    // A workspace package resolves into its own root.
    const wsRoot = workspace.get(pkgName);
    if (wsRoot !== undefined) {
      if (!subpath) {
        const entries = entriesOf(wsRoot);
        if (entries.length > 0) return entries;
        const hit = probe(under(wsRoot, "src/index")) ?? probe(under(wsRoot, "index"));
        return hit ? [hit] : [];
      }
      const hit = probe(under(wsRoot, subpath)) ?? probe(under(wsRoot, `src/${subpath}`));
      return hit ? [hit] : [];
    }
    if (declared.has(pkgName) || NODE_BUILTINS.has(pkgName)) return [];

    // An alias nobody declared to us (a bundler-only `@components`, a
    // tsconfig `baseUrl` import): every file whose path ends the same way.
    const aliasLike = /^[@~#$]/.test(source);
    const tails = aliasLike ? [segs.slice(1).join("/")] : [source, segs.slice(1).join("/")];
    for (const tail of tails) {
      // The index is extension-less; `component/album/edit/dialog.vue` names its file with one.
      const key = tail.replace(STRIP_EXT_RE, "");
      const hits = key ? bySuffix.get(key) : undefined;
      if (hits && hits.length > 0) return [...hits];
    }
    // `@/x`, `~/x`, `#x`, `$x` can only be local, so naming nothing analyzed
    // makes it an unknown. An undeclared `@scope/pkg` or bare name is a
    // dependency the manifests didn't list (hoisted, transitive).
    return /^(?:@\/|[~#$])/.test(source) ? null : [];
  };

  // ── Manifest entries ──
  const manifestEntries: Array<{ file: string; reason: string }> = [];
  const entryFilesByRoot = new Map<string, string[]>();
  const addEntry = (root: string, spec: string, reason: string): void => {
    for (const file of resolveManifestPath(root, spec)) {
      manifestEntries.push({ file, reason });
      push(entryFilesByRoot, root, file);
    }
  };
  const resolveManifestPath = (root: string, spec: string): string[] => {
    const rel = spec.replace(/^\.\//, "");
    if (!rel || rel.startsWith("..") || rel.startsWith("/")) return [];
    if (rel.includes("*")) return globFiles(root, rel);
    // Manifests point at build output; the source lives under src/ (or at
    // the same path without the output directory).
    const hit = probeSource(under(root, rel));
    return hit ? [hit] : [];
  };
  const globFiles = (root: string, rel: string): string[] => {
    const segs = rel.split("/");
    const mapped = OUTPUT_DIRS.has(segs[0]!) ? ["src", ...segs.slice(1)] : segs;
    const prefix = under(root, mapped.slice(0, mapped.findIndex((s) => s.includes("*"))).join("/"));
    const out: string[] = [];
    for (const f of files) {
      if ((prefix === "" || f.startsWith(prefix + "/")) && STRIP_EXT_RE.test(f) && !f.endsWith(".d.ts")) out.push(f);
    }
    return out.sort();
  };
  const entriesOf = (root: string): string[] => [...(entryFilesByRoot.get(root) ?? [])];

  for (const { root, pkg } of packages) {
    if (!pkg) continue;
    for (const field of ["main", "module", "browser", "source", "svelte", "unpkg", "jsdelivr"]) {
      for (const spec of stringLeaves(pkg[field])) addEntry(root, spec, `package.json ${field}`);
    }
    if (pkg.browser && typeof pkg.browser === "object") {
      for (const spec of Object.keys(pkg.browser)) addEntry(root, spec, "package.json browser");
    }
    for (const spec of stringLeaves(pkg.bin)) addEntry(root, spec, "package.json bin");
    for (const spec of stringLeaves(pkg.exports)) addEntry(root, spec, "package.json exports");
    // Commands live in `scripts`, but tools keep their own in package.json
    // too — `prisma.seed`, `jest.setupFiles`, `nodemonConfig.exec`,
    // `lint-staged` — so every string outside the dependency maps is read
    // for script paths.
    for (const [key, value] of Object.entries(pkg)) {
      if (MANIFEST_SKIP_KEYS.has(key)) continue;
      const scripts = key === "scripts" && value && typeof value === "object" ? Object.entries(value) : [[key, value] as const];
      for (const [name, v] of scripts) {
        const reason = key === "scripts" ? `package.json script "${name}"` : `package.json ${key}`;
        for (const cmd of stringLeaves(v)) {
          for (const tok of cmd.split(/[\s=;&|,]+/)) {
            const t = tok.replace(/^["']|["']$/g, "").replace(/^<rootDir>\//, "");
            if (SCRIPT_TOKEN_RE.test(t)) addEntry(root, t, reason);
          }
        }
      }
    }
  }
  for (const root of roots) {
    const wrangler = await readText(join(ctx.projectRoot, root, "wrangler.toml"));
    const main = wrangler && /^\s*main\s*=\s*["']([^"']+)["']/m.exec(wrangler)?.[1];
    if (main) addEntry(root, main, "wrangler.toml main");
    // vite_ruby (Rails): every file under `<sourceCodeDir>/<entrypointsDir>` is
    // an entry a layout's `vite_javascript_tag` names.
    const viteRuby = await readJson(join(ctx.projectRoot, root, "config/vite.json"));
    if (viteRuby) {
      const all = (viteRuby.all && typeof viteRuby.all === "object" ? viteRuby.all : {}) as Record<string, unknown>;
      const src = typeof all.sourceCodeDir === "string" ? all.sourceCodeDir : "app/frontend";
      const entryDir = typeof all.entrypointsDir === "string" ? all.entrypointsDir : "entrypoints";
      const dir = under(root, `${src.replace(/\/+$/, "")}/${entryDir.replace(/^\/+|\/+$/g, "")}`) + "/";
      for (const f of files) {
        if (f.startsWith(dir) && STRIP_EXT_RE.test(f)) manifestEntries.push({ file: f, reason: "vite_ruby entrypoint" });
      }
    }
    // unplugin-vue-components / unplugin-auto-import write a registry
    // (`components.d.ts`: `Agenda: typeof import('./src/components/Agenda.vue')['default']`)
    // for what templates use by TAG, with no import anywhere — so no import
    // graph reaches those components (tessa: 308 of a Vue app's files reported
    // dead). Every module the registry names is registered by the tool and
    // used as a default export.
    for (const name of ["components.d.ts", "auto-imports.d.ts", "src/components.d.ts", "src/auto-imports.d.ts"]) {
      const registry = await readText(join(ctx.projectRoot, root, name));
      if (!registry || !/unplugin|typeof import\(/.test(registry)) continue;
      for (const m of registry.matchAll(/typeof import\(\s*["']([^"']+)["']\s*\)/g)) {
        for (const file of resolve(under(root, name), m[1]!) ?? []) manifestEntries.push({ file, reason: `${name} (auto-registered)` });
      }
    }
    // File-based routers configured in vite: unplugin-vue-router
    // (`VueRouter({ routesFolder: 'src/routes' })`, default `src/pages`) and
    // vite-plugin-pages (`Pages({ dirs: ['src/views'] })`). Every page under
    // the folder is a route the router generates — an entry, like a Nuxt page
    // — and nothing imports it (tessa: 50 pages and the 230 files only they
    // reach were reported dead).
    for (const name of ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"]) {
      const vite = await readText(join(ctx.projectRoot, root, name));
      if (!vite) continue;
      const folders: string[] = [];
      const router = /\bVueRouter\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(vite);
      if (router) folders.push(/routesFolder\s*:\s*["'`]([^"'`]+)["'`]/.exec(router[1]!)?.[1] ?? "src/pages");
      else if (/\bVueRouter\s*\(\s*\)/.test(vite)) folders.push("src/pages");
      const pages = /\bPages\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(vite);
      if (pages) {
        const dirs = [...pages[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!).filter((d) => !d.includes("*") && !d.startsWith("."));
        folders.push(...(dirs.length > 0 ? dirs : ["src/pages"]));
      } else if (/\bPages\s*\(\s*\)/.test(vite)) folders.push("src/pages");
      for (const folder of folders) {
        const dir = under(root, folder.replace(/^\.\/|\/+$/g, "")) + "/";
        for (const f of files) {
          if (f.startsWith(dir) && /\.(?:vue|tsx|jsx|md)$/.test(f)) manifestEntries.push({ file: f, reason: `${name} file-based route (${folder})` });
        }
      }
      break;
    }
    for (const name of ["serverless.yml", "serverless.yaml"]) {
      const sls = await readText(join(ctx.projectRoot, root, name));
      if (!sls) continue;
      // `handler: src/handlers/users.list` — the module, minus the export name.
      for (const m of sls.matchAll(/^\s*handler:\s*["']?([\w@$\-./]+)\.[\w$]+["']?\s*$/gm)) {
        addEntry(root, m[1]!, `${name} handler`);
      }
    }
  }
  // Extension-less `#!/usr/bin/env node` scripts (Express's `bin/www`) load
  // the code beside them, but are never analyzed themselves.
  const scriptDirs = [
    ...[...files].filter((f) => STRIP_EXT_RE.test(f)).map(dirOf),
    ...roots.flatMap((r) => [r, ...SCRIPT_DIRS.map((d) => under(r, d))]),
  ];
  for (const script of await findShebangScripts(ctx.projectRoot, scriptDirs, /\b(?:node|tsx|ts-node|bun|deno)\b/)) {
    for (const m of script.text.matchAll(/(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm)) {
      for (const file of resolve(script.path, m[1]!) ?? []) manifestEntries.push({ file, reason: `script ${script.path}` });
    }
  }
  manifestEntries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.reason < b.reason ? -1 : 1));

  return {
    manifestEntries,

    entryReason(analysis: FileAnalysis, relPath: string, frameworks: ReadonlySet<string>): string | null {
      for (const [re, reason] of CONVENTION_ENTRIES) if (re.test(relPath)) return reason;
      for (const fw of frameworks) {
        for (const [re, reason] of FRAMEWORK_ENTRIES[fw] ?? []) if (re.test(relPath)) return reason;
      }
      // A page the router generates from the file tree (unplugin-vue-router,
      // Next/Nuxt/SvelteKit inference): the file is its own route component.
      if ((analysis.routes ?? []).some((r) => r.kind === "frontend" && r.componentPath === null)) {
        return "file-based route";
      }
      return null;
    },

    passiveReason(analysis: FileAnalysis, relPath: string): string | null {
      for (const [re, reason] of TOOL_LOADED) if (re.test(relPath)) return reason;
      // No import, no export: a classic browser script, loaded by URL from
      // markup — often server-rendered (Razor, JSP, PHP, Delphi templates)
      // where `<script src>` is computed — not by any module. "Nothing
      // imports it" says nothing about such a file.
      if (analysis.imports.length === 0 && analysis.exports.length === 0) return "classic script (loaded by URL, not imported)";
      return null;
    },

    isAmbient: (filePath) => /\.d\.[cm]?ts$/.test(filePath),

    resolve,

    resolvePath(fromFile: string, ref: string): string[] {
      const dir = dirOf(fromFile);
      const root = rootOf(fromFile);
      const base = ref.startsWith("<rootDir>/")
        ? under(dir, ref.slice("<rootDir>/".length))
        : ref.startsWith("/")
          ? under(root, ref.slice(1))
          : under(dir, ref);
      if (/[*?{[]/.test(ref)) {
        const re = globToRegExp(base);
        return [...files].filter((f) => re.test(f)).sort();
      }
      const hit = probeSource(base) ?? (ref.startsWith(".") ? null : probeSource(under(root, ref)));
      return hit ? [hit] : [];
    },

    resolveTag(_fromFile: string, tag: string): string[] {
      return [...(byComponentName.get(normTag(tag)) ?? [])];
    },
  };
}

/** A command-line token naming a script file. */
const SCRIPT_TOKEN_RE = /^(?:\.{0,2}\/)?[\w@$\-./]+\.(?:[cm]?[jt]sx?)$/;
/** package.json keys that hold no paths to run (or are read field by field above). */
const MANIFEST_SKIP_KEYS = new Set([
  "name", "version", "description", "keywords", "author", "contributors", "license", "repository",
  "bugs", "homepage", "funding", "engines", "os", "cpu", "private", "publishConfig", "workspaces",
  "dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies",
  "peerDependenciesMeta", "overrides", "resolutions", "packageManager", "type",
  "main", "module", "browser", "source", "svelte", "unpkg", "jsdelivr", "bin", "exports", "types", "typings",
]);

/** Aliases frameworks define without telling tsconfig, tried in order. */
const FRAMEWORK_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["$lib", ["src/lib"]],
  ["~~", [""]],
  ["@@", [""]],
  ["@", ["src", "app", ""]],
  ["~", ["src", "app", ""]],
];

function normTag(s: string): string {
  return s.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function push<K>(map: Map<K, string[]>, key: K, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Every string inside a manifest field (string, array, nested condition map). */
function stringLeaves(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringLeaves);
  if (v && typeof v === "object") return Object.values(v).flatMap(stringLeaves);
  return [];
}

/**
 * Glob → anchored RegExp over posix project paths: `**` spans directories,
 * `*` and `?` stay within one, `{a,b}` alternates, `[...]` passes through.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { re += "(?:"; depth++; }
    else if (c === "}" && depth > 0) { re += ")"; depth--; }
    else if (c === "," && depth > 0) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else { re += glob.slice(i, end + 1).replace(/^\[!/, "[^"); i = end; }
    } else re += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    const v = JSON.parse(stripJsonc(text)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
