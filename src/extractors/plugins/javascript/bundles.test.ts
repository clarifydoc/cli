import { describe, it, expect } from "vitest";
import { bundlerOf } from "./bundles.js";
import { pluginFor } from "../../registry.js";

const filler = "\n" + "var club = 1;\n".repeat(50);

describe("built bundles", () => {
  it("names the bundler from the runtime it writes first", () => {
    expect(bundlerOf("/******/ (function(modules) { // webpackBootstrap\n/******/ \tvar installedModules = {};" + filler)).toBe("webpack");
    expect(bundlerOf("/*! league v1 */\n/******/ (() => { // webpackBootstrap\n/******/ \t\"use strict\";" + filler)).toBe("webpack");
    expect(bundlerOf("/******/ \tvar __webpack_modules__ = ({" + filler)).toBe("webpack");
    expect(bundlerOf('(window["webpackJsonp"] = window["webpackJsonp"] || []).push([["clubs"],{' + filler)).toBe("webpack");
    expect(bundlerOf('"use strict";\n(self.webpackChunkgarage = self.webpackChunkgarage || []).push([[1],{' + filler)).toBe("webpack");
    expect(bundlerOf("parcelRequire = (function (modules, cache, entry, globalName) {" + filler)).toBe("Parcel");
    expect(bundlerOf("(function(){function r(e,n,t){function o(i,f){if(!n[i]){" + filler)).toBe("browserify");
    expect(bundlerOf("require=(function e(t,n,r){function s(o,u){if(!n[o]){" + filler)).toBe("browserify");
    expect(bundlerOf([
      "var __create = Object.create;",
      "var __commonJS = (cb, mod) => function __require() {};",
      "// node_modules/axios/index.js",
      "var require_axios = __commonJS({});",
      "// src/api/clubs.ts",
      "var clubs = [];",
    ].join("\n"))).toBe("esbuild");
  });

  it("leaves authored source alone, even when it mentions a bundler", () => {
    expect(bundlerOf("// webpackBootstrap is what the old build emitted\nimport axios from 'axios';" + filler)).toBeNull();
    expect(bundlerOf("module.exports = { output: { chunkLoadingGlobal: 'webpackChunkgarage' } };" + filler)).toBeNull();
    expect(bundlerOf("var __commonJS = 1;\n// src/one.ts\nexport const car = 1;")).toBeNull();
    expect(bundlerOf("/******/\n// a banner of stars\nexport const club = 'x';")).toBeNull();
  });

  it("reads a minified build as one, and a generated docs table of contents as no source", () => {
    const minified = '"use strict";(()=>{var ql=Object.defineProperty;' + "var x=1;".repeat(4000) + "})();";
    expect(bundlerOf(minified)).toBe("minified");
    expect(bundlerOf("export const club = 1;\n".repeat(2000))).toBeNull();
    // A library build opens with its license banner, then the minified code.
    const banner = "/**\n *  League widgets\n * @league/widgets 1.4.2\n * License: MIT\n**/\n\n";
    expect(bundlerOf(banner + minified)).toBe("minified");
    expect(bundlerOf("/** Club helpers. */\n" + "export const club = 1;\n".repeat(2000))).toBeNull();
    const toc = '\nwindow.DocInsight = window.DocInsight || {};\nwindow.DocInsight.toc["Squad"] = [ { "n": "TSquad" } ];';
    expect(pluginFor("javascript")!.preprocess!(toc, "docs/toc/Squad.js")).toEqual({ skip: "generated documentation data, not source" });
  });

  it("is skipped by the JavaScript plugin, not the TypeScript one", () => {
    const bundle = "/******/ (function(modules) { // webpackBootstrap" + filler;
    expect(pluginFor("javascript")!.preprocess!(bundle, "public/js/app.js")).toEqual({ skip: "built webpack bundle, not source" });
    expect(pluginFor("javascript")!.preprocess!("export const club = 1;", "src/club.js")).toBeNull();
  });
});
