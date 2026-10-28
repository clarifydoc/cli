import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptImportExportExtractor } from "./imports-exports.js";
import type { ExportInfo } from "../../../types/analysis.js";

async function exportsOf(src: string, lang: "typescript" | "javascript" = "typescript"): Promise<ExportInfo[]> {
  const tree = await parseSource(src, lang as any, lang === "typescript" ? "x.ts" : "x.js");
  return new JavaScriptImportExportExtractor().extractExports(tree, src);
}

const brief = (e: ExportInfo) =>
  [e.name, e.kind, e.source, e.sourceName].filter((v) => v !== undefined).join(" ");

describe("JS/TS export extraction", () => {
  it("names every binding of a const/let export, including destructuring", async () => {
    const out = await exportsOf(`
      export const a = 1, b = 2;
      export const { c, d: renamed, e = 3, ...rest } = obj;
      export const [f, , g] = arr;
      export let fn = () => 1;
    `);
    expect(out.map(brief)).toEqual([
      "a variable", "b variable",
      "c variable", "renamed variable", "e variable", "rest variable",
      "f variable", "g variable",
      "fn function",
    ]);
  });

  it("detects default from the keyword, not from a name that contains it", async () => {
    const out = await exportsOf(`
      export const defaultOptions = {};
      export function setDefault() { switch (x) { default: return 1; } }
      export default function App() {}
    `);
    expect(out.map(brief)).toEqual([
      "defaultOptions variable",
      "setDefault function",
      "default default App",
    ]);
  });

  it("records TS `export =` as the default export", async () => {
    expect((await exportsOf(`const x = 1;\nexport = x;`)).map(brief)).toEqual(["default default"]);
  });

  it("keeps the source of re-exports and leaves local export lists without one", async () => {
    const out = await exportsOf(`
      const local = 1;
      export { local };
      export { x, y as z } from "./xy";
      export * from "./everything";
      export * as ns from "./ns";
      export type { T } from "./types";
    `);
    expect(out.map(brief)).toEqual([
      "local re-export",
      "x re-export ./xy",
      "z re-export ./xy y",
      "* re-export ./everything",
      "ns re-export ./ns *",
      "T re-export ./types",
    ]);
  });

  it("names a renamed local export by what it exports, a reserved word included", async () => {
    const out = await exportsOf(`
      const del = 1, get = 2;
      export { del as delete, get as fetchOne };
    `, "javascript");
    expect(out.map(brief)).toEqual(["delete re-export del", "fetchOne re-export get"]);
  });

  it("covers declaration kinds, ambient declarations and plain JS", async () => {
    const ts = await exportsOf(`
      export abstract class Base {}
      export interface Props {}
      export type Id = string;
      export enum Color { Red }
      export declare function ext(): void;
      export async function* gen() {}
    `);
    expect(ts.map(brief)).toEqual([
      "Base class", "Props interface", "Id type", "Color enum", "ext function", "gen function",
    ]);
    const js = await exportsOf(`export const h = function () {};\nexport * from "./more.js";`, "javascript");
    expect(js.map(brief)).toEqual(["h function", "* re-export ./more.js"]);
  });
});

describe("JS/TS import aliases", () => {
  it("lists the local name and maps it to the export it binds", async () => {
    const src = `import { addPlayersToSquad as signPlayers, getSquad } from '@league/sdk';`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    const [imp] = new JavaScriptImportExportExtractor().extractImports(tree, src);
    expect(imp).toMatchObject({ specifiers: ["signPlayers", "getSquad"], aliases: { signPlayers: "addPlayersToSquad" } });
  });
});

describe("JS/TS dynamic imports", () => {
  it("marks an import() as dynamic, a static import not", async () => {
    const src = `import { Router } from "./router";\nconst routes = [{ path: "/squad", component: () => import("./SquadPage.vue") }];`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    const imports = new JavaScriptImportExportExtractor().extractImports(tree, src);
    expect(imports.map((i) => [i.source, i.dynamic ?? false])).toEqual([["./router", false], ["./SquadPage.vue", true]]);
  });
});

describe("JS/TS nested require()", () => {
  const importsOf = async (src: string) => {
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    return new JavaScriptImportExportExtractor().extractImports(tree, src).map((i) => [i.source, i.line, i.dynamic ?? false]);
  };

  it("reads a require under a condition as a load-time import, one inside a function as dynamic", async () => {
    const src = [
      `import { parentPort } from "worker_threads";`,
      `require("./engine");`,
      `const wheel = require("./wheel");`,
      `if (parentPort) require("./garageWorker");`,
      `function fit() { require("./mirror"); }`,
      `require("./seat").adjust();`,
    ].join("\n");
    expect(await importsOf(src)).toEqual([
      ["worker_threads", 1, false],
      ["./engine", 2, false],
      ["./wheel", 3, false],
      ["./garageWorker", 4, false],
      ["./mirror", 5, true],
      ["./seat", 6, false],
    ]);
  });

  it("records a module once, and a load-time require of a module a function also requires", async () => {
    const src = [
      `const { a,`,
      `  b } = require("./clubs");`,
      `const lazy = () => require("./players");`,
      `if (x) { require("./players"); }`,
      `function again() { require("./clubs"); require("./players"); }`,
    ].join("\n");
    expect(await importsOf(src)).toEqual([
      ["./clubs", 1, false],
      ["./players", 3, true],
      ["./players", 4, false],
    ]);
  });
});

describe("CommonJS module shapes", () => {
  it("records `module.exports = <named function | name>` as the module's default", async () => {
    expect((await exportsOf(`module.exports = function kickoff(team) { return team; };`, "javascript")).map(brief)).toEqual(["default default kickoff"]);
    expect((await exportsOf(`function whistle() {}\nmodule.exports = whistle;`, "javascript")).map(brief)).toEqual(["default default whistle"]);
    // An object of members, or an anonymous function, names no single definition.
    expect(await exportsOf(`module.exports = { whistle };\nexports.x = 1;`, "javascript")).toEqual([]);
    expect(await exportsOf(`module.exports = function () {};`, "javascript")).toEqual([]);
  });

  it("keeps which member a renamed destructured require binds", async () => {
    const src = `const { getClub: fetchClub, listClubs } = require("./api");`;
    const tree = await parseSource(src, "javascript" as any, "x.js");
    const [imp] = new JavaScriptImportExportExtractor().extractImports(tree, src);
    expect(imp!.specifiers).toEqual(["fetchClub", "listClubs"]);
    expect(imp!.aliases).toEqual({ fetchClub: "getClub" });
  });
});
