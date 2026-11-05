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

describe("symbol links through a dispatch map", () => {
  // `const ACTIONS = { save: saveClub, list: loadMatches, limit: LIMIT }` at the top of the module.
  const held = (name: string, key: string, line: number, o: Partial<CallInfo> = {}): CallInfo =>
    ({ name, kind: "internal", target: null, line, passed: "property", returnedAs: `ACTIONS.${key}`, ...o });
  const matches = file("src/lib/matches.ts", { functions: [fn("loadMatches", 1)], exports: [{ name: "loadMatches", kind: "named", line: 1 }] });
  const decoy = file("src/lib/decoy.ts", { functions: [fn("save", 1), fn("list", 4)] });
  const actions = (calls: CallInfo[], params: string[] = []) => file("src/lib/actions.ts", {
    imports: [imp("./matches", ["loadMatches"])],
    functions: [
      fn("<setup>", 1, [
        held("saveClub", "save", 6),
        held("loadMatches", "list", 6, { kind: "cross-file", target: "./matches" }),
        held("LIMIT", "limit", 6),
      ]),
      fn("saveClub", 2),
      { ...fn("run", 10, calls), params: params.map((name) => ({ name, type: null })) },
    ],
  });

  it("links a call of one key to that key's function, and a computed key to every function the map holds", () => {
    const out = linksFrom([matches, decoy, actions([
      { name: "ACTIONS.save", kind: "internal", target: null, line: 11 },
      { name: "ACTIONS[]", kind: "internal", target: null, line: 12 },
    ])], "src/lib/actions.ts");
    expect(out).toEqual([
      "ACTIONS.save -> src/lib/actions.ts::saveClub dispatch",
      "ACTIONS[] -> src/lib/actions.ts::saveClub dispatch",
      "ACTIONS[] -> src/lib/matches.ts::loadMatches dispatch",
      "loadMatches -> src/lib/matches.ts::loadMatches passes",
      "saveClub -> src/lib/actions.ts::saveClub passes",
    ]);
    const conf = buildSymbolLinks([matches, decoy, actions([
      { name: "ACTIONS.save", kind: "internal", target: null, line: 11 },
      { name: "ACTIONS[]", kind: "internal", target: null, line: 12 },
    ])]).filter((l) => l.strategy === "dispatch:object-map").map((l) => `${l.callName} ${l.targetSymbol} ${l.confidence}`).sort();
    expect(conf).toEqual(["ACTIONS.save saveClub EXTRACTED", "ACTIONS[] loadMatches INFERRED", "ACTIONS[] saveClub INFERRED"]);
  });

  it("draws no edge for a key the map does not hold, a value, or a parameter of the map's name", () => {
    expect(linksFrom([matches, decoy, actions([{ name: "ACTIONS.limit", kind: "internal", target: null, line: 11 }])], "src/lib/actions.ts")
      .filter((l) => l.startsWith("ACTIONS"))).toEqual([]);
    expect(linksFrom([matches, decoy, actions([{ name: "ACTIONS.remove", kind: "internal", target: null, line: 11 }])], "src/lib/actions.ts")
      .filter((l) => l.startsWith("ACTIONS"))).toEqual([]);
    expect(linksFrom([matches, decoy, actions([{ name: "ACTIONS.save", kind: "internal", target: null, line: 11 }], ["ACTIONS"])], "src/lib/actions.ts")
      .filter((l) => l.startsWith("ACTIONS"))).toEqual([]);
  });
});

describe("symbol links through a dispatch map of another file", () => {
  const held = (name: string, key: string, line: number): CallInfo =>
    ({ name, kind: "internal", target: null, line, passed: "property", returnedAs: `ACTIONS.${key}` });
  const actions = file("src/lib/actions.ts", {
    functions: [fn("<setup>", 1, [held("saveClub", "save", 5), held("loadMatches", "list", 5)]), fn("saveClub", 2), fn("loadMatches", 3)],
    exports: [{ name: "ACTIONS", kind: "named", line: 5 }],
  });
  const decoy = file("src/lib/decoy.ts", {
    functions: [fn("<setup>", 1, [{ ...held("saveCar", "save", 5) }]), fn("saveCar", 2)],
    exports: [{ name: "ACTIONS", kind: "named", line: 5 }],
  });
  const runner = (calls: CallInfo[], params: string[] = [], specifier = "ACTIONS") => file("src/run.ts", {
    imports: [{ ...imp("./lib/actions", [specifier]), ...(specifier === "ACTIONS" ? {} : { aliases: { [specifier]: "ACTIONS" } }) }],
    functions: [{ ...fn("run", 1, calls), params: params.map((name) => ({ name, type: null })) }],
  });
  const dispatch = (analyses: FileAnalysis[]) => buildSymbolLinks(analyses)
    .filter((l) => l.strategy === "dispatch:object-map").map((l) => `${l.callName} ${l.targetFile}::${l.targetSymbol} ${l.confidence}`).sort();

  it("joins a key to its function and a computed key to every function the imported map holds", () => {
    const calls: CallInfo[] = [
      { name: "ACTIONS.save", kind: "cross-file", target: "./lib/actions", line: 2 },
      { name: "ACTIONS[]", kind: "cross-file", target: "./lib/actions", line: 3 },
    ];
    expect(dispatch([actions, decoy, runner(calls)])).toEqual([
      "ACTIONS.save src/lib/actions.ts::saveClub EXTRACTED",
      "ACTIONS[] src/lib/actions.ts::loadMatches INFERRED",
      "ACTIONS[] src/lib/actions.ts::saveClub INFERRED",
    ]);
  });

  it("follows a renamed import and refuses a parameter of the name, a key the map lacks, and a name never imported", () => {
    expect(dispatch([actions, decoy, runner([{ name: "Registry.list", kind: "cross-file", target: null, line: 2 }], [], "Registry")]))
      .toEqual(["Registry.list src/lib/actions.ts::loadMatches EXTRACTED"]);
    expect(dispatch([actions, decoy, runner([{ name: "Other.list", kind: "cross-file", target: null, line: 2 }])])).toEqual([]);
    expect(dispatch([actions, decoy, runner([{ name: "ACTIONS.save", kind: "cross-file", target: null, line: 2 }], ["ACTIONS"])])).toEqual([]);
    expect(dispatch([actions, decoy, runner([{ name: "ACTIONS.remove", kind: "cross-file", target: null, line: 2 }])])).toEqual([]);
  });
});
