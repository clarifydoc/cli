import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, jsonObject } from "../shared/declared-package.js";
import { parsePackageLock, parsePnpmLock, parseYarnLock, withLocked } from "../shared/lockfiles.js";

/** npm: `package.json`'s dependency sections. */
function parseNpm(text: string, declaredIn: string): DeclaredPackage[] {
  const json = jsonObject(text);
  if (!json) return [];
  const out: DeclaredPackage[] = [];
  const sections: Array<[string, PackageScope]> = [
    ["dependencies", "prod"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
    ["optionalDependencies", "optional"],
  ];
  for (const [key, scope] of sections) {
    const deps = json[key] as Record<string, string> | undefined;
    if (!deps || typeof deps !== "object") continue;
    for (const [name, version] of Object.entries(deps)) {
      out.push(declared(name, typeof version === "string" ? version : null, "npm", scope, declaredIn));
    }
  }
  return out;
}

/** Executables a package installs under another name than its own. */
const BIN_ALIASES: Record<string, readonly string[]> = {
  typescript: ["tsc", "tsserver"],
  "@playwright/test": ["playwright"],
  "@vue/cli-service": ["vue-cli-service"],
  "@angular/cli": ["ng"],
  "npm-run-all": ["npm-run-all", "run-s", "run-p"],
  "npm-run-all2": ["npm-run-all", "run-s", "run-p"],
  "@biomejs/biome": ["biome"],
  "@nestjs/cli": ["nest"],
  storybook: ["storybook", "sb"],
  "@storybook/cli": ["storybook", "sb"],
  "@babel/cli": ["babel"],
  "@babel/node": ["babel-node"],
  "@swc/cli": ["swc"],
  "jest-cli": ["jest"],
  "@electron/rebuild": ["electron-rebuild"],
  "@vscode/vsce": ["vsce"],
  "@vscode/test-cli": ["vscode-test"],
  "@changesets/cli": ["changeset"],
  "@commitlint/cli": ["commitlint"],
  "@sveltejs/kit": ["svelte-kit"],
  "@tauri-apps/cli": ["tauri"],
  "@microsoft/api-extractor": ["api-extractor"],
  "@redocly/cli": ["redocly"],
  "@graphql-codegen/cli": ["graphql-codegen"],
  "@openapitools/openapi-generator-cli": ["openapi-generator-cli"],
  "ts-node": ["ts-node", "ts-node-esm"],
};

/** Tool configuration files beside a package.json whose strings name the packages they load. */
const CONFIG_FILES = [
  ".babelrc", ".babelrc.json", "babel.config.js", "babel.config.json", "babel.config.cjs", "babel.config.mjs",
  ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yml", ".eslintrc.yaml",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts",
  ".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.yml", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
  ".stylelintrc", ".stylelintrc.json", "stylelint.config.js", "stylelint.config.cjs",
  "webpack.config.js", "webpack.config.ts", "webpack.config.cjs", "rollup.config.js", "rollup.config.mjs", "rollup.config.ts",
  "vite.config.ts", "vite.config.js", "vite.config.mts", "vitest.config.ts", "vitest.config.js", "vitest.config.mts",
  "jest.config.js", "jest.config.ts", "jest.config.json", "jest.config.cjs", "jest.config.mjs",
  "postcss.config.js", "postcss.config.cjs", "postcss.config.mjs", "postcss.config.json", ".postcssrc", ".postcssrc.json",
  "tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs", "tsconfig.json", "jsconfig.json",
  "svelte.config.js", "nuxt.config.ts", "next.config.js", "next.config.mjs", "astro.config.mjs",
  "commitlint.config.js", ".commitlintrc", ".commitlintrc.json", "lint-staged.config.js", ".lintstagedrc", ".lintstagedrc.json",
  "playwright.config.ts", "cypress.config.ts", "cypress.config.js", "karma.conf.js", "angular.json",
  ".mocharc", ".mocharc.json", ".mocharc.js", ".mocharc.yml", "nodemon.json", "tsup.config.ts", ".swcrc", "turbo.json", "nx.json",
];

/** The command words of every `scripts` entry: `"build": "tsc -p . && vite build"` → tsc, vite. */
function scriptCommands(json: Record<string, unknown>): Set<string> {
  const words = new Set<string>();
  const scripts = json.scripts as Record<string, unknown> | undefined;
  if (!scripts || typeof scripts !== "object") return words;
  for (const cmd of Object.values(scripts)) {
    if (typeof cmd !== "string") continue;
    for (const part of cmd.split(/&&|\|\||[;|&]/)) {
      const tokens = part.trim().split(/\s+/).filter((t) => t && !/^[A-Z_][A-Z0-9_]*=/.test(t));
      let i = 0;
      // Runners that execute the next word: `npx tsc`, `pnpm exec vitest`, `cross-env NODE_ENV=x jest`.
      while (i < tokens.length && /^(?:npx|pnpx|bunx|exec|dlx|cross-env|dotenv|env|node|bun|yarn|pnpm|npm|-[\w-]+)$/.test(tokens[i]!)) {
        if (tokens[i] !== "node" && tokens[i] !== "bun") words.add(tokens[i]!);
        i++;
      }
      if (tokens[i]) words.add(tokens[i]!.replace(/^\.\/node_modules\/\.bin\//, ""));
      for (const t of tokens.slice(i + 1)) if (/^[a-z@][\w@/.-]*$/.test(t)) words.add(t);
    }
  }
  return words;
}

/** The spellings a tool config names a package by: its full name, and the plugin/preset shorthand. */
function configSpellings(name: string): string[] {
  const out = [name];
  // `"types": ["node"]` in a tsconfig, `"env": { "node": true }` in an ESLint config.
  if (name === "@types/node") out.push("node");
  const scoped = /^(@[^/]+)\/(eslint-plugin|eslint-config|prettier-plugin|babel-plugin|babel-preset)(?:-(.+))?$/.exec(name);
  if (scoped) out.push(scoped[3] ? `${scoped[1]}/${scoped[3]}` : scoped[1]!);
  const bare = /^(?:eslint-plugin|eslint-config|prettier-plugin|babel-plugin|babel-preset|stylelint-config|postcss)-(.+)$/.exec(name);
  if (bare) out.push(bare[1]!);
  return out;
}

/**
 * Marks what package.json's own `scripts` run and what a tool config beside it
 * names: tooling is used without ever being imported, and reporting it
 * unused was most of the npm noise (17 of 20 packages in one extension).
 */
async function markToolUsage(pkgs: DeclaredPackage[], json: Record<string, unknown>, readSibling: (n: string) => Promise<string | null>): Promise<void> {
  const commands = scriptCommands(json);
  const configs: string[] = [];
  // package.json's own tool sections (`eslintConfig`, `babel`, `prettier`, `jest`, `browserslist`…).
  const ownConfig = { ...json };
  for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "scripts", "name", "version", "description"]) delete ownConfig[k];
  configs.push(JSON.stringify(ownConfig));
  for (const f of CONFIG_FILES) {
    const c = await readSibling(f);
    if (c) configs.push(c);
  }
  const configText = configs.join("\n");
  for (const p of pkgs) {
    const usedBy: Array<"script" | "config"> = [];
    const bins = BIN_ALIASES[p.name] ?? [p.name.replace(/^@[^/]+\//, ""), p.name];
    if (bins.some((b) => commands.has(b))) usedBy.push("script");
    if (configSpellings(p.name).some((sp) => mentioned(configText, sp))) usedBy.push("config");
    if (usedBy.length > 0) p.usedBy = usedBy;
  }
}

/** Whether a config names `word` as a string (`"ts-loader"`, `'plugin:react/…'`, `["@babel/preset-env", {…}]`). */
function mentioned(config: string, word: string): boolean {
  const w = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\x60](?:plugin:)?${w}(?:["'\x60/]|$)`, "m").test(config);
}

export const npmPackageManager: PackageManagerSpec = {
  ecosystem: "npm",
  manifests: [{
    files: ["package.json"],
    async parse(text, file) {
      const pkgs = parseNpm(text, file.declaredIn);
      const json = jsonObject(text);
      if (json) await markToolUsage(pkgs, json, (n) => file.readSibling(n));
      const npmLock = await file.readSibling("package-lock.json");
      if (npmLock) return withLocked(pkgs, parsePackageLock(npmLock));
      const yarn = await file.readSibling("yarn.lock");
      if (yarn) return withLocked(pkgs, parseYarnLock(yarn));
      const pnpm = await file.readSibling("pnpm-lock.yaml");
      return pnpm ? withLocked(pkgs, parsePnpmLock(pnpm)) : pkgs;
    },
    selfName: (text) => { const name = jsonObject(text)?.name; return typeof name === "string" && name ? name : null; },
  }],
  // `@scope/pkg/sub` → `@scope/pkg`, `lodash/fp` → `lodash`; relative paths
  // and the `@/` / `~` aliases name project files.
  importKey(s) {
    if (s.startsWith(".") || s.startsWith("/") || s.startsWith("@/") || s.startsWith("~")) return null;
    if (s.startsWith("@")) {
      const parts = s.split("/");
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null;
    }
    return s.split("/")[0]!.toLowerCase();
  },
  assertsUnused: true,
  // `@types/react` is used when `react` is; `@types/babel__core` types `@babel/core`.
  impliedBy(name) {
    const m = /^@types\/(.+)$/.exec(name);
    if (!m) return null;
    const t = m[1]!;
    return (t.includes("__") ? `@${t.replace("__", "/")}` : t).toLowerCase();
  },
};
