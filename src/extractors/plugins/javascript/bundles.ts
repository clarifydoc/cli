/**
 * Built JavaScript bundles committed beside the source: a Laravel Mix /
 * webpack `public/js/app.js`, an esbuild or Parcel output file. A bundle is
 * the project's own modules (often an older version of them) concatenated
 * with every library they import, so analyzing it as source repeats the
 * project's api-calls from a file nobody edits, pins them to line 48,000 of a
 * library-sized file, and links screens to routes through code that may no
 * longer exist. Discovery's globs catch the conventional names
 * (`*.bundle.js`, `*.min.js`, `dist/`); this catches the rest by the runtime
 * every bundler writes at the top of its output.
 *
 * Head-window only: each marker is something the bundler emits before the
 * first module, and an authored file never opens with one.
 */

/** How far into the file the markers are looked for. */
const HEAD = 4096;

/** webpack 4/5 non-minified output: `/******\/ (function(modules) { // webpackBootstrap`, `/******\/ (() => { // webpackBootstrap`. */
const WEBPACK_BOOTSTRAP_RE = /^\/\*{6}\/[^\n]*\bwebpackBootstrap\b/m;
/** webpack's runtime lines, each prefixed `/******\/`, around `__webpack_require__` / `__webpack_modules__`. */
const WEBPACK_RUNTIME_LINE_RE = /^\/\*{6}\/[^\n]*\b__webpack_(?:require|modules)__\b/m;
/** A webpack chunk file: `(window["webpackJsonp"] = window["webpackJsonp"] || []).push(…`, `(self.webpackChunkapp = …`. */
const WEBPACK_CHUNK_RE = /^\s*(?:"use strict";\s*)?\(\s*(?:window|self|this|globalThis)(?:\[\s*["']webpack(?:Jsonp|Chunk)[\w$]*["']\s*\]|\.webpack(?:Jsonp|Chunk)[\w$]*)\s*=/m;
/** Parcel's prelude: `parcelRequire = (function (modules, cache, entry, globalName) {`, Parcel 2's `var parcelRequire = $parcel$global[…]`. */
const PARCEL_RE = /\bparcelRequire[\w$]*\s*=|\$parcel\$global\b/;
/** browserify's prelude: `(function(){function r(e,n,t){function o(i,f){…`, older `(function e(t,n,r){function s(o,u){…`. */
const BROWSERIFY_RE = /^(?:require\s*=\s*)?\(function(?:\(\)\s*\{\s*function r|\s+e)\((?:e,n,t|t,n,r)\)\s*\{\s*function (?:o\(i,f\)|s\(o,u\))\s*\{/;
/** esbuild's module helpers (`var __commonJS = (cb, mod) => …`), which a bundle declares before its first module. */
const ESBUILD_HELPER_RE = /^var __(?:commonJS|esm|toESM|toCommonJS|require) = /m;
/** esbuild names each bundled module in a comment line: `// node_modules/axios/index.js`, `// src/api/clubs.ts`. */
const ESBUILD_MODULE_COMMENT_RE = /^\/\/ [\w@.\-/]+\.(?:[cm]?[jt]sx?|vue|svelte|json)$/gm;

/**
 * Which bundler wrote this file, when its head says so; null for source.
 *
 * @param sourceText - The whole file
 */
export function bundlerOf(sourceText: string): string | null {
  const head = sourceText.slice(0, HEAD);
  // A minified build: its whole head one line (esbuild's minified prelude, a terser output). An authored line is never that long.
  if (sourceText.length > 20_000 && !head.slice(0, 3000).includes("\n") && head.length >= 3000) return "minified";
  if (WEBPACK_BOOTSTRAP_RE.test(head) || WEBPACK_RUNTIME_LINE_RE.test(head) || WEBPACK_CHUNK_RE.test(head)) return "webpack";
  if (PARCEL_RE.test(head)) return "Parcel";
  if (BROWSERIFY_RE.test(head.trimStart())) return "browserify";
  if (ESBUILD_HELPER_RE.test(head) && (sourceText.match(ESBUILD_MODULE_COMMENT_RE)?.length ?? 0) >= 2) return "esbuild";
  return null;
}

/**
 * The JavaScript plugin's preprocess: a bundle is skipped, anything else is
 * analyzed as written.
 */
/** A documentation generator's data file (DocInsight's `window.DocInsight.toc[…] = [ … ]`): generated beside the HTML it serves. */
const GENERATED_DOCS_RE = /^\s*window\.DocInsight\s*=/m;

export function bundlePreprocess(rawSource: string): { skip: string } | null {
  if (GENERATED_DOCS_RE.test(rawSource.slice(0, 400))) return { skip: "generated documentation data, not source" };
  const bundler = bundlerOf(rawSource);
  return bundler ? { skip: `built ${bundler} bundle, not source` } : null;
}
