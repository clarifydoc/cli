import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { NOISE_CALLS } from "../../shared/call-graph.js";
import { javascriptFrameworkRules } from "./frameworks.js";
import { npmPackageManager } from "./package-manifests.js";
import { jsServiceConfig } from "./service-config.js";

/**
 * Prototype members of core JS builtins (Array/Set/Map/String/Object/Promise/
 * RegExp/Date/JSON). A call like `seen.add(x)` or `s.toUpperCase()` must never
 * be linked to a project method that happens to share the name. Built on the
 * shared NOISE_CALLS set (extraction-side noise filter) — both lists describe
 * the same "ubiquitous JS member names" domain and must not drift apart.
 */
const JS_BUILTIN_MEMBERS = [...new Set([
  ...NOISE_CALLS,
  // Set/Map/collections
  "add", "delete", "has", "get", "set", "clear",
  // Array
  "slice", "splice", "concat", "reduceRight", "findIndex", "findLast",
  "findLastIndex", "includes", "indexOf", "lastIndexOf",
  "flat", "flatMap", "fill", "sort", "reverse", "at", "copyWithin",
  // String
  "toUpperCase", "toLowerCase", "toLocaleUpperCase", "toLocaleLowerCase",
  "charAt", "charCodeAt", "codePointAt", "normalize", "trim", "trimStart",
  "trimEnd", "padStart", "padEnd", "startsWith", "endsWith",
  "replaceAll", "match", "matchAll", "search", "substring",
  "substr", "repeat", "localeCompare",
  // Object/Function/general
  "toLocaleString", "hasOwnProperty", "bind", "call", "apply", "assign", "freeze",
  // Iterator
  "next",
  // RegExp/Date/Number
  "test", "exec", "getTime", "toISOString", "toFixed", "toPrecision",
  // React hooks (called as `React.useState` etc. — framework, not project code)
  "useState", "useEffect", "useMemo", "useCallback", "useRef", "useContext",
  "useReducer", "useLayoutEffect", "useId", "useTransition",
])];

/**
 * JS/TS test files beyond the generic `*.test.*` / `*.spec.*` / `__tests__/`
 * conventions: `_spec.js`/`-spec.ts` (Cypress integration specs), `.cy.ts`
 * (Cypress component tests), and `_test.js`. Extension class covers
 * js/jsx/ts/tsx and the m/c (ESM/CJS) variants.
 */
const JS_TEST_PATTERNS: readonly RegExp[] = [
  /[._-]spec\.[cm]?[jt]sx?$/i,
  /[._-]test\.[cm]?[jt]sx?$/i,
  /\.cy\.[cm]?[jt]sx?$/i,
];

/** npm import source → framework id (shared by the ts and js manifests). */
const NPM_FRAMEWORK_HINTS: Readonly<Record<string, string>> = {
  "react": "react",
  "react-dom": "react",
  "react-router": "react-router",
  "react-router-dom": "react-router",
  "next": "nextjs",
  "next/router": "nextjs",
  "next/navigation": "nextjs",
  "vue": "vue",
  "vue-router": "vue-router",
  "nuxt": "nuxt",
  "svelte": "svelte",
  "@sveltejs/kit": "sveltekit",
  "pinia": "pinia",
  "vuex": "vuex",
  "express": "express",
  "@nestjs/common": "nestjs",
  "@nestjs/core": "nestjs",
  "fastify": "fastify",
  "@angular/core": "angular",
  "@angular/router": "angular",
  "react-redux": "react-redux",
  "@reduxjs/toolkit": "redux",
  "@tanstack/react-query": "react-query",
  // ORM imports
  "@prisma/client": "prisma",
  "prisma": "prisma",
  "typeorm": "typeorm",
  "sequelize": "sequelize",
  "sequelize-typescript": "sequelize",
  "drizzle-orm": "drizzle",
  "@mikro-orm/core": "mikro-orm",
  "mongoose": "mongoose",
  "knex": "knex",
  "objection": "objection",
  "kysely": "kysely",
};

/** React Native's platform files (`Button.ios.tsx`), react-native-web's `.web`. */
export const JS_PLATFORM_SUFFIXES = [".native", ".ios", ".android", ".web"] as const;

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts, package-manifests.ts and service-config.ts only.
 */
export const typescriptManifest: LanguagePluginManifest = {
  language: "typescript",
  family: "script",
  packageManagers: [npmPackageManager],
  packageEcosystems: ["npm"],
  // `process.env.X` / `import.meta.env.X` bases; `.env` files are never read.
  serviceConfig: jsServiceConfig,
  parsing: "tree-sitter",
  extensions: [".ts", ".tsx", ".vue", ".svelte"],
  // A field is only reached through the instance (`this.x`); a bare name never is one.
  explicitSelfMembers: true,
  platformSuffixes: JS_PLATFORM_SUFFIXES,
  grammar: {
    variants: { typescript: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-typescript.wasm" }, tsx: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-tsx.wasm" } },
    keyForFile: (filePath) =>
      filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? "tsx" : "typescript",
  },
  testFilePatterns: JS_TEST_PATTERNS,
  builtinMembers: JS_BUILTIN_MEMBERS,
  frameworkImportHints: NPM_FRAMEWORK_HINTS,
  // Family plugin: npm-ecosystem framework rules ride on the typescript
  // manifest only, so the registry sees each rule exactly once.
  frameworkRules: javascriptFrameworkRules,
  activationFiles: ["package.json"],
};

export const javascriptManifest: LanguagePluginManifest = {
  language: "javascript",
  family: "script",
  // A package's `bin/` scripts, when its package.json declares `bin`.
  sourceDirs: [{ dir: "bin", marker: "package.json", markerMatches: /"bin"\s*:/ }],
  packageEcosystems: ["npm"],
  // `process.env.X` / `import.meta.env.X` bases; `.env` files are never read.
  serviceConfig: jsServiceConfig,
  parsing: "tree-sitter",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  // A field is only reached through the instance (`this.x`); a bare name never is one.
  explicitSelfMembers: true,
  platformSuffixes: JS_PLATFORM_SUFFIXES,
  grammar: { variants: { javascript: { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" } } },
  testFilePatterns: JS_TEST_PATTERNS,
  builtinMembers: JS_BUILTIN_MEMBERS,
  frameworkImportHints: NPM_FRAMEWORK_HINTS,
};
