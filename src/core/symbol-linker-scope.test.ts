import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis, FunctionInfo, SymbolLink } from "../types/analysis.js";

const call = (name: string, line: number, extra: Partial<CallInfo> = {}): CallInfo => ({ name, kind: "internal", target: null, line, ...extra });

const fn = (name: string, line: number, endLine: number, calls: CallInfo[] = [], extra: Partial<FunctionInfo> = {}): FunctionInfo =>
  ({ name, line, endLine, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [], ...extra });

const cls = (name: string, line: number, endLine: number, methods: FunctionInfo[], extra: Record<string, unknown> = {}) =>
  ({ name, kind: "class", extends: null, implements: [], methods, properties: [], decorators: [], line, endLine, ...extra });

const file = (filePath: string, language: string, opts: { functions?: FunctionInfo[]; classes?: unknown[]; imports?: unknown[] }): FileAnalysis =>
  ({
    filePath,
    projectId: "root",
    language,
    functions: opts.functions ?? [],
    classes: opts.classes ?? [],
    imports: opts.imports ?? [],
    exports: [],
    routes: [],
    dataSources: [],
  } as unknown as FileAnalysis);

const from = (links: SymbolLink[], sourceSymbol: string, callName: string) =>
  links.filter((l) => l.sourceSymbol === sourceSymbol && l.callName === callName);

describe("symbol-linker — a bare call resolves in the caller's own class first", () => {
  it("links `Club.play(){ load(); }` to Club's load, not the Squad declared above it (Kotlin)", () => {
    const kt = file("Club.kt", "kotlin", {
      classes: [
        cls("Squad", 1, 3, [fn("load", 2, 2)]),
        cls("Club", 5, 8, [fn("load", 6, 6), fn("play", 7, 7, [call("load", 7)])]),
      ],
    });
    const [link] = from(buildSymbolLinks([kt]), "Club.play", "load");
    expect(link).toMatchObject({ targetSymbol: "Club.load", targetLine: 6, confidence: "EXTRACTED", strategy: "direct" });
  });

  it("links a bare call of the later class to its own method, not the first class's (Java)", () => {
    const java = file("Club.java", "java", {
      classes: [
        cls("Club", 1, 4, [fn("train", 2, 2), fn("play", 3, 3, [call("train", 3)])]),
        cls("Garage", 5, 5, [fn("train", 5, 5), fn("park", 5, 5, [call("train", 5)])]),
      ],
    });
    const links = buildSymbolLinks([java]);
    expect(from(links, "Garage.park", "train")[0]).toMatchObject({ targetSymbol: "Garage.train", targetLine: 5 });
    expect(from(links, "Club.play", "train")[0]).toMatchObject({ targetSymbol: "Club.train", targetLine: 2 });
  });

  it("walks the caller's bases before another class of the file (C#)", () => {
    const cs = file("Kit.cs", "csharp", {
      classes: [
        cls("Van", 1, 1, [fn("Wash", 1, 1)]),
        cls("Kit", 2, 2, [fn("Wash", 2, 2)]),
        cls("Bus", 3, 3, [fn("Go", 3, 3, [call("Wash", 3)])], { extends: "Kit" }),
      ],
    });
    const [link] = from(buildSymbolLinks([cs]), "Bus.Go", "Wash");
    expect(link).toMatchObject({ targetSymbol: "Kit.Wash", targetLine: 2, strategy: "inheritance", confidence: "INFERRED" });
  });

  it("reaches an enclosing class's member from a nested class (Java inner class)", () => {
    const java = file("Club.java", "java", {
      classes: [
        cls("Club", 1, 8, [fn("load", 2, 2)]),
        cls("Squad", 3, 5, [fn("pick", 4, 4, [call("load", 4)])]),
      ],
    });
    const [link] = from(buildSymbolLinks([java]), "Squad.pick", "load");
    expect(link).toMatchObject({ targetSymbol: "Club.load", targetLine: 2 });
  });

  it("never links a bare call to an unrelated class's method of the file", () => {
    const java = file("Club.java", "java", {
      classes: [
        cls("Kit", 1, 1, [fn("wash", 1, 1)]),
        cls("Garage", 2, 2, [fn("park", 2, 2, [call("wash", 2)])]),
      ],
    });
    expect(from(buildSymbolLinks([java]), "Garage.park", "wash")).toEqual([]);
  });

  it("never links a free function's bare call to a class member (Kotlin)", () => {
    const kt = file("Stats.kt", "kotlin", {
      functions: [fn("tally", 5, 7, [call("count", 6)])],
      classes: [cls("Table", 1, 3, [fn("count", 2, 2)])],
    });
    expect(from(buildSymbolLinks([kt]), "tally", "count")).toEqual([]);
  });

  it("lets an extension function's bare call reach its receiver type (Kotlin `fun Club.extra()`)", () => {
    const kt = file("Club.kt", "kotlin", {
      functions: [fn("extra", 5, 5, [call("load", 5)], { params: [{ name: "this", type: "Club", isReceiver: true } as never] })],
      classes: [cls("Club", 1, 3, [fn("load", 2, 2)])],
    });
    expect(from(buildSymbolLinks([kt]), "extra", "load")[0]).toMatchObject({ targetSymbol: "Club.load" });
  });

  it("finds an out-of-line C++ member's sibling in another translation unit before a class of its own file", () => {
    const cc = file("club.cc", "cpp", {
      classes: [
        cls("Garage", 2, 2, [fn("train", 3, 3)]),
        cls("Club", 4, 4, [fn("play", 4, 4, [call("train", 4)])], { extension: true }),
      ],
    });
    const other = file("club_train.cc", "cpp", { classes: [cls("Club", 2, 2, [fn("train", 2, 2)], { extension: true })] });
    const header = file("club.h", "cpp", { classes: [cls("Club", 2, 2, [])] });
    const [link] = from(buildSymbolLinks([cc, other, header]), "Club.play", "train");
    expect(link).toMatchObject({ targetFile: "club_train.cc", targetSymbol: "Club.train" });
  });

  it("keeps another class's member as a guess where the extractor drops receivers (C++ `coach->drill()`)", () => {
    const cc = file("club.cc", "cpp", {
      functions: [fn("tally", 9, 9, [call("drill", 9)])],
      classes: [
        cls("Club", 1, 3, [fn("run", 2, 2, [call("drill", 2)])], { extension: true }),
        cls("Coach", 4, 4, [fn("drill", 4, 4)], { extension: true }),
      ],
    });
    const links = buildSymbolLinks([cc]);
    expect(from(links, "Club.run", "drill")[0]).toMatchObject({ targetSymbol: "Coach.drill", confidence: "INFERRED" });
    expect(from(links, "tally", "drill")[0]).toMatchObject({ targetSymbol: "Coach.drill", confidence: "INFERRED" });
  });

  it("leaves Python's bare names to module functions", () => {
    const py = file("m.py", "python", {
      functions: [fn("train", 5, 6)],
      classes: [cls("Club", 8, 13, [fn("train", 9, 10), fn("play", 12, 13, [call("train", 13)])])],
    });
    expect(from(buildSymbolLinks([py]), "Club.play", "train")[0]).toMatchObject({ targetSymbol: "train", targetLine: 5 });
  });
});

describe("symbol-linker — a class called by name stays in the caller's language family", () => {
  const coach = file("coach.py", "python", { classes: [cls("Coach", 1, 3, [fn("train", 3, 3)])] });

  it("never links a Swift or Ruby `Coach.train()` to a Python `Coach`", () => {
    const swift = file("Squad.swift", "swift", { classes: [cls("Squad", 1, 3, [fn("pick", 2, 2, [call("Coach.train", 2)])])] });
    const ruby = file("garage.rb", "ruby", { classes: [cls("Garage", 1, 5, [fn("open", 2, 4, [call("Coach.train", 3)])])] });
    const links = buildSymbolLinks([coach, swift, ruby]);
    expect(links.filter((l) => l.targetFile === "coach.py")).toEqual([]);
  });

  it("still links a same-family class by name", () => {
    const caller = file("squad.py", "python", { functions: [fn("pick", 1, 2, [call("Coach.train", 2)])] });
    const [link] = buildSymbolLinks([coach, caller]).filter((l) => l.callName === "Coach.train");
    expect(link).toMatchObject({ targetFile: "coach.py", targetSymbol: "Coach.train", strategy: "class-name" });
  });
});

describe("symbol-linker — a C/C++ call through a header reaches the definition beside it", () => {
  const include = (source: string) => ({ source, specifiers: [source.replace(/\..*$/, "")], isDefault: false, isNamespace: false, isType: false, line: 1 });
  const main = file("src/main.cc", "cpp", { functions: [fn("main", 3, 6, [call("helper", 5)])], imports: [include("helpers.h")] });
  const header = file("src/helpers.h", "cpp", {});
  const body = file("src/helpers.cc", "cpp", { functions: [fn("helper", 2, 2)], imports: [include("helpers.h")] });

  it("links `helper(4)` to the body in the header's same-stem file", () => {
    const [link] = buildSymbolLinks([main, header, body]).filter((l) => l.sourceSymbol === "main");
    expect(link).toMatchObject({ targetFile: "src/helpers.cc", targetSymbol: "helper", strategy: "import-file", confidence: "INFERRED" });
  });

  it("ignores a `static` namesake in another translation unit", () => {
    const other = file("tools/helpers.cc", "cpp", { functions: [fn("helper", 1, 1, [], { isExported: false })] });
    const unrelated = file("src/other.cc", "cpp", { functions: [fn("helper", 1, 1, [], { isExported: false })] });
    const [link] = buildSymbolLinks([main, header, body, other, unrelated]).filter((l) => l.sourceSymbol === "main");
    expect(link).toMatchObject({ targetFile: "src/helpers.cc" });
  });

  it("decides nothing when two translation units define it", () => {
    const twin = file("tools/helpers.cc", "cpp", { functions: [fn("helper", 1, 1)] });
    expect(buildSymbolLinks([main, header, body, twin]).filter((l) => l.sourceSymbol === "main")).toEqual([]);
  });
});

describe("symbol-linker — nested functions of one name resolve to the nearest in scope", () => {
  const imp = (source: string, name: string) => ({ source, specifiers: [name], isDefault: false, isNamespace: false, isType: false, line: 1 });
  const target = (links: SymbolLink[], sourceSymbol: string, callName: string, line?: number) =>
    links.filter((l) => l.sourceSymbol === sourceSymbol && l.callName === callName && (line === undefined || l.sourceLine === line))
      .map((l) => `${l.targetFile}:${l.targetLine}`);

  it("links each caller to its own inner function, and an outside caller to the top-level one", () => {
    const ts = file("src/club.ts", "typescript", {
      functions: [
        fn("first", 2, 2, [call("run", 2)]),
        fn("run", 2, 2),
        fn("second", 3, 3, [call("run", 3)]),
        fn("run", 3, 3),
        fn("helper", 5, 5),
        fn("kickoff", 6, 9, [call("helper", 8)]),
        fn("helper", 7, 7),
        fn("restart", 10, 10, [call("helper", 10)]),
      ],
    });
    const links = buildSymbolLinks([ts]);
    expect(target(links, "first", "run")).toEqual(["src/club.ts:2"]);
    expect(target(links, "second", "run")).toEqual(["src/club.ts:3"]);
    expect(target(links, "kickoff", "helper")).toEqual(["src/club.ts:7"]);
    expect(target(links, "restart", "helper")).toEqual(["src/club.ts:5"]);
  });

  it("reaches a sibling declared in an enclosing function, and never another function's inner helper", () => {
    const ts = file("src/panels.ts", "typescript", {
      functions: [
        fn("Left", 1, 6, [call("onSave", 5)]),
        fn("onSave", 2, 2),
        fn("onClick", 3, 4, [call("onSave", 4)]),
        fn("Right", 7, 9),
        fn("onSave", 8, 8),
        fn("Middle", 10, 10, [call("onSave", 10)]),
      ],
    });
    const links = buildSymbolLinks([ts]);
    expect(target(links, "Left", "onSave")).toEqual(["src/panels.ts:2"]);
    expect(target(links, "onClick", "onSave")).toEqual(["src/panels.ts:2"]);
    expect(target(links, "Middle", "onSave")).toEqual([]);
  });

  it("lets an inner function shadow an import of its name", () => {
    const ts = file("src/match.ts", "typescript", {
      functions: [
        fn("replay", 2, 2, [call("scoreGoal", 2, { kind: "cross-file", target: "./goals" })]),
        fn("scoreGoal", 2, 2),
        fn("highlight", 3, 3, [call("scoreGoal", 3, { kind: "cross-file", target: "./goals" })]),
      ],
      imports: [imp("./goals", "scoreGoal")],
    });
    const goals = file("src/goals.ts", "typescript", { functions: [fn("scoreGoal", 1, 1)] });
    const links = buildSymbolLinks([ts, goals]);
    expect(target(links, "replay", "scoreGoal")).toEqual(["src/match.ts:2"]);
    expect(target(links, "highlight", "scoreGoal")).toEqual(["src/goals.ts:1"]);
  });

  it("follows the one inner helper a caller is handed, as a parameter or from the function declaring it", () => {
    const py = file("league.py", "python", {
      functions: [
        fn("parse", 1, 5, [call("validate", 4, { kind: "internal" }), call("report", 5)]),
        fn("report", 2, 3),
        fn("validate", 6, 7, [call("report", 7)], { params: [{ name: "report", type: null } as never] }),
        fn("use_pages", 8, 10),
        fn("fetch_page", 9, 9),
        fn("show", 11, 13, [call("use_pages", 12), call("fetch_page", 13)]),
      ],
    });
    const links = buildSymbolLinks([py]);
    expect(links.find((l) => l.sourceSymbol === "validate" && l.callName === "report")).toMatchObject({ targetLine: 2, confidence: "INFERRED" });
    expect(links.find((l) => l.sourceSymbol === "show" && l.callName === "fetch_page")).toMatchObject({ targetLine: 9, confidence: "INFERRED" });
  });

  it("lets a template reach the one inner function its component's setup() returns", () => {
    // `setup() { const revealBench = () => …; return { revealBench } }` and `@open="revealBench"` below the script.
    const vue = file("src/MatchView.vue", "vue", {
      functions: [
        fn("setup", 2, 6),
        fn("revealBench", 3, 3),
        // The SFC reader lists a setup-scoped function twice.
        fn("revealBench", 3, 3),
        fn("<setup>", 1, 1, [call("revealBench", 12)]),
        fn("<BenchBar@open@14>", 14, 14, [call("revealBench", 14)]),
      ],
    });
    const links = buildSymbolLinks([vue]);
    expect(links.find((l) => l.sourceSymbol === "<setup>" && l.callName === "revealBench")).toMatchObject({ targetLine: 3, confidence: "INFERRED" });
    expect(links.find((l) => l.sourceSymbol === "<BenchBar@open@14>" && l.callName === "revealBench")).toMatchObject({ targetLine: 3, confidence: "INFERRED" });
  });
});

describe("symbol-linker — a static call on a project class reaches it whatever its name says", () => {
  it("links `ClubStore.save(…)`, classified as database by its name, to the class's method", () => {
    const store = file("ClubStore.java", "java", { classes: [cls("ClubStore", 1, 4, [fn("save", 2, 2), fn("find", 3, 3)])] });
    const coach = file("Coach.java", "java", {
      classes: [cls("Coach", 1, 5, [fn("run", 2, 4, [call("ClubStore.save", 3, { kind: "database" }), call("jdbc.update", 4, { kind: "database" })])])],
    });
    const links = buildSymbolLinks([store, coach]);
    expect(links.find((l) => l.callName === "ClubStore.save")).toMatchObject({ targetSymbol: "ClubStore.save", strategy: "class-name" });
    expect(links.find((l) => l.callName === "jdbc.update")).toBeUndefined();
  });

  it("leaves a database call on a class that does not declare the method alone (an ORM's inherited finder)", () => {
    const model = file("club.rb", "ruby", { classes: [cls("Club", 1, 3, [fn("captain", 2, 2)], { extends: "ApplicationRecord" })] });
    const ctrl = file("clubs_controller.rb", "ruby", {
      classes: [cls("ClubsController", 1, 3, [fn("show", 2, 2, [call("Club.find", 2, { kind: "database" })])])],
    });
    expect(buildSymbolLinks([model, ctrl]).filter((l) => l.callName === "Club.find")).toEqual([]);
  });
});
