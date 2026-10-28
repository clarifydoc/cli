/**
 * A module's default export reached under another local name, and barrels
 * that forward a name through more than one hop: the call links to the
 * definition, never to an export row on the way.
 */
import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis } from "../types/analysis.js";

const fn = (name: string, line: number, calls: CallInfo[] = []) =>
  ({ name, line, endLine: line + 2, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [] });
const call = (name: string, line: number, target: string): CallInfo => ({ name, kind: "cross-file", target, line });
const imp = (source: string, specifiers: string[], o: { isDefault?: boolean; isNamespace?: boolean; aliases?: Record<string, string> } = {}) =>
  ({ source, specifiers, isDefault: o.isDefault ?? false, isNamespace: o.isNamespace ?? false, isType: false, line: 1, ...(o.aliases ? { aliases: o.aliases } : {}) });
const file = (filePath: string, o: { functions?: unknown[]; imports?: unknown[]; exports?: unknown[] }): FileAnalysis =>
  ({ filePath, language: "typescript", projectId: "root", imports: o.imports ?? [], exports: o.exports ?? [], functions: o.functions ?? [], classes: [], routes: [], dataSources: [] }) as unknown as FileAnalysis;

/** Calls made by `from`, as `callName -> file::symbol`. */
function callsFrom(analyses: FileAnalysis[], from: string): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.sourceFile === from && l.sourceSymbol !== "(reference)")
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

describe("symbol links to a default export under another name", () => {
  it("links a default import to the function the module exports as its default", () => {
    const tyre = file("src/tyre.ts", { functions: [fn("inflate", 1)], exports: [{ name: "default", kind: "default", line: 2, sourceName: "inflate" }] });
    const wax = file("src/wax.ts", { functions: [fn("polishEngine", 1)], exports: [{ name: "default", kind: "default", line: 1, sourceName: "polishEngine" }] });
    const main = file("src/main.ts", {
      imports: [imp("./tyre", ["pump"], { isDefault: true }), imp("./wax", ["shine"], { isDefault: true })],
      functions: [fn("runGarage", 3, [call("pump", 3, "./tyre"), call("shine", 3, "./wax")])],
    });
    expect(callsFrom([tyre, wax, main], "src/main.ts")).toEqual([
      "pump -> src/tyre.ts::inflate",
      "shine -> src/wax.ts::polishEngine",
    ]);
  });

  it("follows `export { default as x } from` to the function, and to the object a member is called on", () => {
    const players = file("src/api/players.js", { functions: [fn("listPlayers", 2)], exports: [{ name: "default", kind: "default", line: 3, sourceName: "listPlayers" }] });
    const clubs = file("src/api/clubs.js", { functions: [fn("getClubs", 3)], exports: [{ name: "default", kind: "default", line: 2 }] });
    const barrel = file("src/api/index.js", {
      exports: [
        { name: "fetchPlayers", kind: "re-export", line: 1, source: "./players", sourceName: "default" },
        { name: "clubApi", kind: "re-export", line: 2, source: "./clubs", sourceName: "default" },
      ],
    });
    const main = file("src/main.js", {
      imports: [imp("./api", ["fetchPlayers", "clubApi"])],
      functions: [fn("boot", 4, [call("fetchPlayers", 4, "./api"), call("clubApi.getClubs", 4, "./api")])],
    });
    expect(callsFrom([players, clubs, barrel, main], "src/main.js")).toEqual([
      "clubApi.getClubs -> src/api/clubs.js::getClubs",
      "fetchPlayers -> src/api/players.js::listPlayers",
    ]);
  });

  it("keeps a default import named like the module's own function on that function", () => {
    const wheel = file("src/wheel.ts", { functions: [fn("spin", 1)], exports: [{ name: "default", kind: "default", line: 1, sourceName: "spin" }] });
    const main = file("src/main.ts", { imports: [imp("./wheel", ["spin"], { isDefault: true })], functions: [fn("service", 3, [call("spin", 3, "./wheel")])] });
    expect(callsFrom([wheel, main], "src/main.ts")).toEqual(["spin -> src/wheel.ts::spin"]);
  });

  it("never takes a module's default through `export *`", () => {
    const tuning = file("src/engine/tuning.ts", { functions: [fn("polishEngine", 1)], exports: [{ name: "default", kind: "default", line: 1, sourceName: "polishEngine" }] });
    const barrel = file("src/engine/index.ts", { exports: [{ name: "*", kind: "re-export", line: 1, source: "./tuning" }] });
    const main = file("src/main.ts", { imports: [imp("./engine", ["polish"], { isDefault: true })], functions: [fn("run", 2, [call("polish", 2, "./engine")])] });
    expect(callsFrom([tuning, barrel, main], "src/main.ts")).toEqual([]);
  });
});

describe("symbol links through barrel chains", () => {
  it("does not stop at an intermediate barrel's renamed re-export", () => {
    const tuning = file("src/engine/tuning.ts", { functions: [fn("revLimiter", 1)], exports: [{ name: "revLimiter", kind: "function", line: 1 }] });
    const engine = file("src/engine/index.ts", { exports: [{ name: "limitRevs", kind: "re-export", line: 1, source: "./tuning", sourceName: "revLimiter" }] });
    const root = file("src/index.ts", { exports: [{ name: "*", kind: "re-export", line: 1, source: "./engine" }] });
    const service = file("src/garage/service.ts", {
      imports: [imp("../index", ["limitRevs"])],
      functions: [fn("serviceCar", 2, [call("limitRevs", 3, "../index")])],
    });
    expect(callsFrom([tuning, engine, root, service], "src/garage/service.ts")).toEqual(["limitRevs -> src/engine/tuning.ts::revLimiter"]);
  });

  it("follows a sourceless re-export of an imported name, and a namespace re-export's member", () => {
    const pads = file("src/brakes/pads.ts", { functions: [fn("fitPads", 1)], exports: [{ name: "fitPads", kind: "function", line: 1 }] });
    const brakes = file("src/brakes/index.ts", { imports: [imp("./pads", ["fitPads"])], exports: [{ name: "fitPads", kind: "re-export", line: 2 }] });
    const spray = file("src/paint/spray.ts", { functions: [fn("sprayCar", 1)], exports: [{ name: "sprayCar", kind: "function", line: 1 }] });
    const paint = file("src/paint/index.ts", { exports: [{ name: "paintShop", kind: "re-export", line: 1, source: "./spray", sourceName: "*" }] });
    const garage = file("src/garage/one.ts", {
      imports: [imp("../brakes", ["fitPads"]), imp("../paint", ["paintShop"])],
      functions: [fn("serviceCar", 3, [call("fitPads", 4, "../brakes"), call("paintShop.sprayCar", 5, "../paint"), call("paintShop.missing", 6, "../paint")])],
    });
    expect(callsFrom([pads, brakes, spray, paint, garage], "src/garage/one.ts")).toEqual([
      "fitPads -> src/brakes/pads.ts::fitPads",
      "paintShop.sprayCar -> src/paint/spray.ts::sprayCar",
    ]);
  });

  it("keeps a re-export that leads out of the project as the target", () => {
    const barrel = file("src/ui/index.ts", { exports: [{ name: "Toast", kind: "re-export", line: 1, source: "toast-kit" }] });
    const shim = file("src/index.ts", { exports: [{ name: "*", kind: "re-export", line: 1, source: "./ui" }] });
    const main = file("src/main.ts", { imports: [imp("./index", ["Toast"])], functions: [fn("run", 2, [call("Toast", 2, "./index")])] });
    expect(callsFrom([barrel, shim, main], "src/main.ts")).toEqual(["Toast -> src/ui/index.ts::Toast"]);
  });
});
