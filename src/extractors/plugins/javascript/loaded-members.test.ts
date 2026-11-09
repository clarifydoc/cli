import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { JavaScriptImportExportExtractor } from "./imports-exports.js";

describe("calls on a module loaded in place", () => {
  it("are the module's member at its path; no phantom default call; the namesake call stays local", async () => {
    const src = `
      export async function a() { (await import('./rules')).promote(1); }
      export function d() { return require('./rules').relegate(4); }
      export async function e() { await import('./rules'); other.promote(2); }`;
    const tree = await parseSource(src, "javascript" as any, "x.js");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const calls = (n: string) => fns.find((f) => f.name === n)!.calls.filter((c) => c.name !== "require").map((c) => [c.name, c.kind, c.target]);
    expect(calls("a")).toEqual([["promote", "cross-file", "./rules"]]);
    expect(calls("d")).toEqual([["relegate", "cross-file", "./rules"]]);
    expect(calls("e")).toEqual([["other.promote", "internal", null]]);
  });

  it("keeps the default link of a lazy loader and of a `.default` read", async () => {
    const src = `
      const ClubPage = () => import('./pages/ClubPage.vue');
      export async function boot() { const m = (await import('./auth')).default; return m(); }
      export async function pick() { const { promote } = await import('./rules'); return promote(); }`;
    const tree = await parseSource(src, "javascript" as any, "x.js");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const defaults = (n: string) => fns.find((f) => f.name === n)!.calls.filter((c) => c.name === "default").map((c) => c.target);
    expect(defaults("ClubPage")).toEqual(["./pages/ClubPage.vue"]);
    expect(defaults("boot")).toEqual(["./auth"]);
    expect(defaults("pick")).toEqual([]);
  });

  it("reads a module loader's settled result as the module; a path held in a variable names none", async () => {
    const src = `
      const loadRules = () => import('./rules');
      const loadCup = async () => { return import('./cup'); };
      let cached;
      const loadLeague = () => (cached ??= import('./league'));
      function loadTable() { return import('./table'); }
      const byPath = (path) => import(path);
      export async function a() { return (await loadRules()).promote(1); }
      export async function b() { return (await loadCup()).promote(2); }
      export async function c() { return (await loadLeague()).relegate(3); }
      export async function d() { return (await byPath('./rules')).promote(4); }
      export function e() { return loadRules().promote(5); }
      export async function f() { const table = await loadTable(); return table.standings(); }
      export function g() { return loadRules().then((rules) => rules.promote(6)); }
      export async function h() { const pending = loadRules(); const { relegate } = await loadCup(); return relegate(); }`;
    const tree = await parseSource(src, "javascript" as any, "x.js");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const loaded = (n: string) => fns.find((f) => f.name === n)!.calls.filter((c) => c.kind === "cross-file").map((c) => [c.name, c.target]);
    expect(loaded("a")).toEqual([["promote", "./rules"]]);
    expect(loaded("b")).toEqual([["promote", "./cup"]]);
    expect(loaded("c")).toEqual([["relegate", "./league"]]);
    expect(loaded("d")).toEqual([]);
    expect(loaded("e")).toEqual([]);
    const imports = new JavaScriptImportExportExtractor().extractImports(tree, src);
    const bound = imports.filter((i) => i.specifiers.length > 0).map((i) => [i.source, i.specifiers.join(","), i.isNamespace, i.line]);
    expect(bound).toEqual([
      ["./table", "table", true, 13],
      ["./rules", "rules", true, 14],
      ["./cup", "relegate", false, 15],
    ]);
  });
});
