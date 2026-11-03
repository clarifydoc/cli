/**
 * A name handed on (`register(onSave)`, `onClick={saveClub}`) links as `passes`: only to a
 * function, method or class, and only through a resolution that did not guess by name.
 */
import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis } from "../types/analysis.js";

const fn = (name: string, line: number, calls: CallInfo[] = []) =>
  ({ name, line, endLine: line + 2, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [] });
const imp = (source: string, specifiers: string[]) =>
  ({ source, specifiers, isDefault: false, isNamespace: false, isType: false, line: 1 });
const file = (filePath: string, o: { functions?: unknown[]; imports?: unknown[]; exports?: unknown[] }): FileAnalysis =>
  ({ filePath, language: "typescript", projectId: "root", imports: o.imports ?? [], exports: o.exports ?? [], functions: o.functions ?? [], classes: [], routes: [], dataSources: [] }) as unknown as FileAnalysis;

/** Links made by `from`, as `callName -> file::symbol relation`. */
function linksFrom(analyses: FileAnalysis[], from: string): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.sourceFile === from && l.sourceSymbol !== "(reference)")
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol} ${l.relation}`)
    .sort();
}

describe("symbol links for names handed on", () => {
  const clubs = file("src/api/clubs.ts", {
    functions: [fn("saveClub", 1)],
    exports: [{ name: "saveClub", kind: "named", line: 1 }, { name: "squad", kind: "named", line: 5 }],
  });

  it("links an imported function handed to a handler as `passes`", () => {
    const page = file("src/pages/ClubPage.tsx", {
      imports: [imp("../api/clubs", ["saveClub"])],
      functions: [fn("ClubPage", 1, [{ name: "saveClub", kind: "cross-file", target: "../api/clubs", line: 2, passed: "attribute" }])],
    });
    expect(linksFrom([clubs, page], "src/pages/ClubPage.tsx")).toEqual(["saveClub -> src/api/clubs.ts::saveClub passes"]);
  });

  it("draws no edge for a value handed on (an imported constant)", () => {
    const boot = file("src/boot.ts", {
      imports: [imp("./api/clubs", ["squad"])],
      functions: [fn("boot", 1, [{ name: "squad", kind: "cross-file", target: "./api/clubs", line: 2, passed: "argument" }])],
    });
    expect(linksFrom([clubs, boot], "src/boot.ts")).toEqual([]);
  });

  it("links a component file handed on to its default export", () => {
    const card = file("src/components/ClubCard.vue", { exports: [{ name: "default", kind: "default", line: 1 }] });
    const spec = file("src/components/ClubCard.spec.ts", {
      imports: [{ ...imp("./ClubCard.vue", ["ClubCard"]), isDefault: true }],
      functions: [fn("mountCard", 1, [{ name: "ClubCard", kind: "cross-file", target: "./ClubCard.vue", line: 2, passed: "argument" }])],
    });
    expect(linksFrom([card, spec], "src/components/ClubCard.spec.ts")).toEqual(["ClubCard -> src/components/ClubCard.vue::default passes"]);
  });

  it("never takes a name-only guess, though a call of the same name does", () => {
    // `pit.refuel_car` on an untyped `pit`: only the method's name points at `Pit` (unique-global).
    const pitstop = { ...file("league/pit.py", {}), language: "python",
      classes: [{ name: "Pit", kind: "class", extends: null, implements: [], methods: [fn("refuel_car", 2)], properties: [], decorators: [], line: 1, endLine: 4 }] } as unknown as FileAnalysis;
    const race = (passed?: "argument") => ({ ...file("league/race.py", {}), language: "python",
      functions: [fn("race", 1, [{ name: "pit.refuel_car", kind: "internal", target: null, line: 2, ...(passed ? { passed } : {}) }])] }) as unknown as FileAnalysis;
    expect(linksFrom([pitstop, race()], "league/race.py")).toEqual(["pit.refuel_car -> league/pit.py::Pit.refuel_car calls"]);
    expect(linksFrom([pitstop, race("argument")], "league/race.py")).toEqual([]);
  });
});
