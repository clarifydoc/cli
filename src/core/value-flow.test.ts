/**
 * The value-flow solver: function values followed through locals, parameters, fields, lists and returns to the
 * call that runs them. Facts are built by hand; every case keeps a same-named decoy a name tier would grab.
 */
import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis, ValueFlowFact } from "../types/analysis.js";

type Param = { name: string; type: string | null; defaultValue: string | null };
const param = (name: string, type: string | null = null): Param => ({ name, type, defaultValue: null });
const fn = (name: string, line: number, o: { params?: Param[]; calls?: CallInfo[]; valueFlow?: ValueFlowFact[]; localTypes?: Array<{ name: string; type: string }> } = {}) =>
  ({ name, line, endLine: line + 8, params: o.params ?? [], calls: o.calls ?? [], returnType: null, isAsync: false, isExported: true, decorators: [], ...(o.valueFlow ? { valueFlow: o.valueFlow } : {}), ...(o.localTypes ? { localTypes: o.localTypes } : {}) });
const cls = (name: string, line: number, methods: unknown[], properties: unknown[] = []) =>
  ({ name, kind: "class", extends: null, implements: [], decorators: [], methods, properties, line, endLine: line + 30 });
const imp = (source: string, specifiers: string[]) =>
  ({ source, specifiers, isDefault: false, isNamespace: false, isType: false, line: 1 });
const file = (filePath: string, o: { functions?: unknown[]; classes?: unknown[]; imports?: unknown[]; exports?: unknown[]; moduleValueFlow?: ValueFlowFact[]; language?: string }): FileAnalysis =>
  ({ filePath, language: o.language ?? "typescript", projectId: "root", imports: o.imports ?? [], exports: o.exports ?? [], functions: o.functions ?? [], classes: o.classes ?? [], routes: [], dataSources: [], ...(o.moduleValueFlow ? { moduleValueFlow: o.moduleValueFlow } : {}) }) as unknown as FileAnalysis;
const exp = (...names: string[]) => names.map((name, i) => ({ name, kind: "named", line: i + 1 }));
const call = (name: string, line: number, o: Partial<CallInfo> = {}): CallInfo => ({ name, kind: "internal", target: null, line, ...o });

/** `source -> target` of the value-flow links, sorted. */
function flowLinks(analyses: FileAnalysis[]): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceFile}::${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

const saveClub = file("src/api/clubs.ts", { functions: [fn("saveClub", 1)], exports: exp("saveClub", "retireClub"), });

describe("value-flow: a function value through locals, arguments and formals", () => {
  const decoy = file("src/run/decoys.ts", { functions: [fn("handler", 1)], exports: exp("handler") });
  const runner = file("src/run/runner.ts", {
    functions: [fn("run", 1, { params: [param("cb")], valueFlow: [{ kind: "copy", from: { name: "cb" }, to: { name: "handler" }, line: 2 }, { kind: "invoke", cell: { name: "handler" }, call: "handler", line: 3 }], calls: [call("handler", 3)] }), fn("handler", 20)],
    exports: exp("run"),
  });
  const page = file("src/pages/ClubPage.ts", {
    imports: [imp("../api/clubs", ["saveClub"]), imp("../run/runner", ["run"])],
    functions: [fn("boot", 1, {
      calls: [call("run", 5, { kind: "cross-file", target: "../run/runner" })],
      valueFlow: [
        { kind: "seed", to: { name: "h" }, fn: "saveClub", line: 3 },
        { kind: "copy", from: { name: "h" }, to: { name: "g" }, line: 4 },
        { kind: "arg", call: "run", line: 5, index: 0, from: { name: "g" } },
      ],
    })],
  });

  it("reaches the function across files and is never stolen by a global namesake", () => {
    const links = flowLinks([saveClub, decoy, runner, page]);
    expect(links).toEqual(["src/run/runner.ts::run@3 handler -> src/api/clubs.ts::saveClub"]);
    const all = buildSymbolLinks([saveClub, decoy, runner, page]);
    expect(all.some((l) => l.targetSymbol === "handler" && l.callName === "handler")).toBe(false);
  });

  it("is INFERRED, never EXTRACTED", () => {
    const l = buildSymbolLinks([saveClub, decoy, runner, page]).find((x) => x.strategy === "value-flow")!;
    expect(l.confidence).toBe("INFERRED");
    expect(l.relation).toBe("calls");
  });

  it("states nothing when no function holds the value", () => {
    const bare = file("src/pages/ClubPage.ts", { functions: [fn("boot", 1, { calls: [call("run", 5, { kind: "cross-file", target: "../run/runner" })] })], imports: page.imports });
    expect(flowLinks([saveClub, decoy, runner, bare])).toEqual([]);
  });
});

describe("value-flow: fields", () => {
  const onSaveDecoy = file("src/other/decoys.ts", { functions: [fn("onSave", 1)], exports: exp("onSave") });

  it("stores and loads through `this`", () => {
    const club = file("src/club.ts", {
      functions: [fn("saveClub", 1)],
      classes: [cls("Club", 10, [
        fn("setup", 11, { valueFlow: [{ kind: "seed", to: { name: "this", member: "onSave" }, fn: "saveClub", line: 12 }] }),
        fn("fire", 20, { valueFlow: [{ kind: "invoke", cell: { name: "this", member: "onSave" }, call: "this.onSave", line: 21 }], calls: [call("this.onSave", 21)] }),
      ])],
    });
    expect(flowLinks([club, onSaveDecoy])).toEqual(["src/club.ts::Club.fire@21 this.onSave -> src/club.ts::saveClub"]);
  });

  it("stores through a typed local and loads through a typed parameter", () => {
    const club = file("src/club.ts", { classes: [cls("Club", 1, [])], exports: exp("Club") });
    const wiring = file("src/wiring.ts", {
      imports: [imp("./club", ["Club"]), imp("./api/clubs", ["saveClub"])],
      functions: [
        fn("make", 1, { localTypes: [{ name: "c", type: "Club" }], valueFlow: [{ kind: "seed", to: { name: "c", member: "onSave" }, fn: "saveClub", line: 2 }] }),
        fn("fire", 10, { params: [param("club", "Club")], valueFlow: [{ kind: "invoke", cell: { name: "club", member: "onSave" }, call: "club.onSave", line: 11 }], calls: [call("club.onSave", 11)] }),
      ],
    });
    const clubs = file("src/api/clubs.ts", { functions: [fn("saveClub", 1)], exports: exp("saveClub") });
    expect(flowLinks([club, wiring, clubs, onSaveDecoy])).toEqual(["src/wiring.ts::fire@11 club.onSave -> src/api/clubs.ts::saveClub"]);
  });

  it("finds a field a base class declares through the extends chain", () => {
    const sub = { ...cls("Sub", 1, [
      fn("setup", 2, { valueFlow: [{ kind: "seed", to: { name: "this", member: "onSave" }, fn: "saveClub", line: 3 }] }),
    ]), extends: "Base" };
    const subFile = file("src/sub.ts", { classes: [sub], imports: [imp("./base", ["Base"]), imp("./api/clubs", ["saveClub"])] });
    const baseFire = file("src/base.ts", {
      classes: [cls("Base", 1, [fn("fire", 5, { valueFlow: [{ kind: "invoke", cell: { name: "this", member: "onSave" }, call: "this.onSave", line: 6 }], calls: [call("this.onSave", 6)] })], [{ name: "onSave" }])],
      exports: exp("Base"),
    });
    const clubs = file("src/api/clubs.ts", { functions: [fn("saveClub", 1)], exports: exp("saveClub") });
    expect(flowLinks([baseFire, subFile, clubs])).toEqual(["src/base.ts::Base.fire@6 this.onSave -> src/api/clubs.ts::saveClub"]);
  });

  it("stores and loads through a module holder", () => {
    const holder = file("src/registry.ts", {
      exports: exp("registry"),
      moduleValueFlow: [{ kind: "result", call: "createRegistry", line: 1, to: { name: "registry" } }],
    });
    const writer = file("src/setup.ts", {
      imports: [imp("./registry", ["registry"]), imp("./api/clubs", ["saveClub"])],
      functions: [fn("install", 1, { valueFlow: [{ kind: "seed", to: { name: "registry", member: "onSave" }, fn: "saveClub", line: 2 }] })],
    });
    const reader = file("src/fire.ts", {
      imports: [imp("./registry", ["registry"])],
      functions: [fn("fire", 1, { valueFlow: [{ kind: "invoke", cell: { name: "registry", member: "onSave" }, call: "registry.onSave", line: 2 }], calls: [call("registry.onSave", 2)] })],
    });
    const clubs = file("src/api/clubs.ts", { functions: [fn("saveClub", 1)], exports: exp("saveClub") });
    expect(flowLinks([holder, writer, reader, clubs, onSaveDecoy])).toEqual(["src/fire.ts::fire@2 registry.onSave -> src/api/clubs.ts::saveClub"]);
  });

  it("stores into an imported name through the importing file's module facts", () => {
    const holder = file("src/hooks.ts", {
      exports: exp("onKick"),
      moduleValueFlow: [{ kind: "copy", from: { name: "onKick" }, to: { name: "onKick" }, line: 1 }],
      functions: [fn("fire", 1, { valueFlow: [{ kind: "copy", from: { name: "onKick" }, to: { name: "f" }, line: 2 }, { kind: "invoke", cell: { name: "f" }, call: "f", line: 3 }], calls: [call("f", 3)] })],
    });
    const writer = file("src/boot.ts", {
      imports: [imp("./hooks", ["onKick"])],
      moduleValueFlow: [{ kind: "seed", to: { name: "onKick" }, fn: "saveClub", line: 2 }],
      functions: [fn("saveClub", 1)],
    });
    expect(flowLinks([holder, writer])).toEqual(["src/hooks.ts::fire@3 f -> src/boot.ts::saveClub"]);
  });

  it("keeps a rebinding of an imported name local to the importing file", () => {
    const holder = file("src/hooks.ts", {
      exports: exp("onKick"),
      moduleValueFlow: [{ kind: "copy", from: { name: "onKick" }, to: { name: "onKick" }, line: 1 }],
      functions: [fn("fire", 1, { valueFlow: [{ kind: "copy", from: { name: "onKick" }, to: { name: "f" }, line: 2 }, { kind: "invoke", cell: { name: "f" }, call: "f", line: 3 }], calls: [call("f", 3)] })],
    });
    const writer = file("src/boot.ts", {
      imports: [imp("./hooks", ["onKick"])],
      moduleValueFlow: [{ kind: "result", call: "wrap", line: 2, to: { name: "onKick" } }, { kind: "seed", to: { name: "onKick" }, fn: "saveClub", line: 3 }],
      functions: [fn("saveClub", 1)],
    });
    expect(flowLinks([holder, writer])).toEqual([]);
  });
});

describe("value-flow: lists, returns, cycles and limits", () => {
  const clubs = file("src/api/clubs.ts", {
    functions: [fn("saveClub", 1), fn("retireClub", 5), fn("loanClub", 9)],
    exports: exp("saveClub", "retireClub", "loanClub"),
  });

  it("holds the handlers of a list under `[]`", () => {
    const wiring = file("src/wiring.ts", {
      imports: [imp("./api/clubs", ["saveClub", "retireClub"])],
      functions: [fn("fire", 1, {
        valueFlow: [
          { kind: "seed", to: { name: "handlers", member: "[]" }, fn: "saveClub", line: 2 },
          { kind: "seed", to: { name: "handlers", member: "[]" }, fn: "retireClub", line: 3 },
          { kind: "invoke", cell: { name: "handlers", member: "[]" }, call: "handler", line: 5 },
        ],
        localTypes: [{ name: "handlers", type: "Handler[]" }],
        calls: [call("handler", 5)],
      })],
    });
    expect(flowLinks([clubs, wiring])).toEqual([
      "src/wiring.ts::fire@5 handler -> src/api/clubs.ts::retireClub",
      "src/wiring.ts::fire@5 handler -> src/api/clubs.ts::saveClub",
    ]);
  });

  it("follows a return into the result cell of the call", () => {
    const factory = file("src/factory.ts", {
      imports: [imp("./api/clubs", ["saveClub"])],
      functions: [fn("makeHandler", 1, { valueFlow: [
        { kind: "seed", to: { name: "h" }, fn: "saveClub", line: 2 },
        { kind: "return", from: { name: "h" }, line: 3 },
      ] })],
      exports: exp("makeHandler"),
    });
    const use = file("src/use.ts", {
      imports: [imp("./factory", ["makeHandler"])],
      functions: [fn("fire", 1, {
        calls: [call("makeHandler", 2, { kind: "cross-file", target: "./factory" }), call("cb", 3)],
        valueFlow: [
          { kind: "result", call: "makeHandler", line: 2, to: { name: "cb" } },
          { kind: "invoke", cell: { name: "cb" }, call: "cb", line: 3 },
        ],
      })],
    });
    expect(flowLinks([clubs, factory, use])).toEqual(["src/use.ts::fire@3 cb -> src/api/clubs.ts::saveClub"]);
  });

  it("terminates on a copy cycle", () => {
    const loop = file("src/loop.ts", {
      imports: [imp("./api/clubs", ["saveClub"])],
      functions: [fn("spin", 1, { valueFlow: [
        { kind: "seed", to: { name: "a" }, fn: "saveClub", line: 2 },
        { kind: "copy", from: { name: "a" }, to: { name: "b" }, line: 3 },
        { kind: "copy", from: { name: "b" }, to: { name: "a" }, line: 4 },
        { kind: "invoke", cell: { name: "b" }, call: "b", line: 5 },
      ], calls: [call("b", 5)] })],
    });
    expect(flowLinks([clubs, loop])).toEqual(["src/loop.ts::spin@5 b -> src/api/clubs.ts::saveClub"]);
  });

  it("marks 5 to 32 targets AMBIGUOUS", () => {
    const many = file("src/many.ts", { functions: Array.from({ length: 6 }, (_, i) => fn(`play${i}`, 1 + i * 3)), exports: exp(...Array.from({ length: 6 }, (_, i) => `play${i}`)) });
    const user = file("src/user.ts", {
      imports: [imp("./many", Array.from({ length: 6 }, (_, i) => `play${i}`))],
      functions: [fn("fire", 1, { valueFlow: [
        ...Array.from({ length: 6 }, (_, i) => ({ kind: "seed", to: { name: "all" }, fn: `play${i}`, line: 2 + i }) as ValueFlowFact),
        { kind: "invoke", cell: { name: "all" }, call: "each", line: 10 },
      ], localTypes: [{ name: "all", type: "Fn[]" }], calls: [call("each", 10)] })],
    });
    const links = buildSymbolLinks([many, user]).filter((l) => l.strategy === "value-flow");
    expect(links).toHaveLength(6);
    expect(links.every((l) => l.confidence === "AMBIGUOUS")).toBe(true);
  });

  it("emits nothing for 33 targets, and nothing downstream of them", () => {
    const names = Array.from({ length: 33 }, (_, i) => `play${i}`);
    const many = file("src/many.ts", { functions: names.map((n, i) => fn(n, 1 + i * 3)), exports: exp(...names) });
    const user = file("src/user.ts", {
      imports: [imp("./many", names)],
      functions: [fn("fire", 1, { valueFlow: [
        ...names.map((n, i) => ({ kind: "seed", to: { name: "all" }, fn: n, line: 2 + i }) as ValueFlowFact),
        { kind: "copy", from: { name: "all" }, to: { name: "down" }, line: 50 },
        { kind: "invoke", cell: { name: "all" }, call: "each", line: 51 },
        { kind: "invoke", cell: { name: "down" }, call: "later", line: 52 },
      ], localTypes: [{ name: "all", type: "Fn[]" }], calls: [call("each", 51), call("later", 52)] })],
    });
    expect(flowLinks([many, user])).toEqual([]);
  });

  it("never reaches a test file's function from production code", () => {
    const prod = file("src/slot.ts", {
      exports: exp("slot"),
      moduleValueFlow: [{ kind: "result", call: "createSlot", line: 1, to: { name: "slot" } }],
      functions: [fn("fire", 3, { valueFlow: [{ kind: "invoke", cell: { name: "slot" }, call: "slot", line: 4 }], calls: [call("slot", 4)] })],
    });
    const spec = file("src/slot.spec.ts", {
      imports: [imp("./slot", ["slot"])],
      functions: [fn("fakeSave", 1), fn("arrange", 5, { valueFlow: [{ kind: "seed", to: { name: "slot" }, fn: "fakeSave", line: 6 }] })],
    });
    expect(flowLinks([prod, spec])).toEqual([]);
  });
});

describe("value-flow: closures", () => {
  it("lets a closure written in a method invoke the method's parameter", () => {
    const club = file("src/club.ts", {
      functions: [{ ...fn("<register.each@4>", 4, { valueFlow: [{ kind: "invoke", cell: { name: "cb" }, call: "cb", line: 5 }], calls: [call("cb", 5)] }), endLine: 6 }],
      classes: [cls("Club", 1, [{ ...fn("register", 2, { params: [param("cb")] }), endLine: 9 }])],
      exports: exp("Club"),
    });
    const wiring = file("src/wiring.ts", {
      imports: [imp("./club", ["Club"]), imp("./api/clubs", ["saveClub"])],
      functions: [fn("plug", 1, {
        localTypes: [{ name: "club", type: "Club" }],
        calls: [call("club.register", 4)],
        valueFlow: [
          { kind: "seed", to: { name: "h" }, fn: "saveClub", line: 3 },
          { kind: "arg", call: "club.register", line: 4, index: 0, from: { name: "h" } },
        ],
      })],
    });
    const clubs = file("src/api/clubs.ts", { functions: [fn("saveClub", 1)], exports: exp("saveClub") });
    expect(flowLinks([club, wiring, clubs])).toEqual(["src/club.ts::<register.each@4>@5 cb -> src/api/clubs.ts::saveClub"]);
  });
});

describe("value-flow: receiver offset", () => {
  it("binds written argument 0 to the first formal after `self`", () => {
    const club = file("league/club.py", {
      language: "python",
      classes: [cls("Club", 1, [
        fn("register", 2, { params: [param("self"), param("cb")], valueFlow: [{ kind: "invoke", cell: { name: "cb" }, call: "cb", line: 3 }], calls: [call("cb", 3)] }),
      ])],
      exports: exp("Club"),
    });
    const clubs = file("league/api.py", { language: "python", functions: [fn("save_club", 1)], exports: exp("save_club") });
    const decoy = file("league/decoy.py", { language: "python", functions: [fn("cb", 1)], exports: exp("cb") });
    const plug = file("league/plug.py", {
      language: "python",
      imports: [imp("league.club", ["Club"]), imp("league.api", ["save_club"])],
      functions: [fn("plug", 1, {
        localTypes: [{ name: "club", type: "Club" }],
        calls: [call("club.register", 4)],
        valueFlow: [
          { kind: "seed", to: { name: "h" }, fn: "save_club", line: 3 },
          { kind: "arg", call: "club.register", line: 4, index: 0, from: { name: "h" } },
        ],
      })],
    });
    expect(flowLinks([club, clubs, decoy, plug])).toEqual(["league/club.py::Club.register@3 cb -> league/api.py::save_club"]);
  });
});

describe("value-flow: a type's members, field paths and module writes", () => {
  const handlers = file("src/ops.c", {
    language: "c",
    functions: [fn("club_sign", 1), fn("rival_sign", 2)],
    classes: [
      cls("club_ops", 10, [], [{ name: "sign" }]),
      cls("rival_ops", 20, [], [{ name: "sign" }]),
      cls("club", 30, [], [{ name: "ops", type: "struct club_ops" }]),
    ],
    moduleValueFlow: [
      { kind: "seed", to: { name: "club_ops", member: "sign" }, fn: "club_sign", line: 5 },
      { kind: "seed", to: { name: "rival_ops", member: "sign" }, fn: "rival_sign", line: 6 },
    ],
  });

  it("an unbound class name states the members every value of that type shares; a field path walks property types", () => {
    const user = file("src/use.c", {
      language: "c",
      functions: [fn("by_club", 1, {
        params: [param("c", "struct club")],
        calls: [call("sign", 2)],
        valueFlow: [{ kind: "invoke", cell: { name: "c.ops", member: "sign" }, call: "sign", line: 2 }],
      })],
    });
    expect(flowLinks([handlers, user])).toEqual(["src/use.c::by_club@2 sign -> src/ops.c::club_sign"]);
  });

  it("a function writes a module binding it does not declare through the `<module>` cell", () => {
    const unit = file("src/hook.c", {
      language: "c",
      functions: [
        fn("on_kick", 1),
        fn("set_hook", 5, { params: [param("cb")], valueFlow: [{ kind: "copy", from: { name: "cb" }, to: { name: "<module>", member: "g_hook" }, line: 6 }] }),
        fn("wire", 10, { calls: [call("set_hook", 11)], valueFlow: [{ kind: "seed", to: { name: "$a" }, fn: "on_kick", line: 11 }, { kind: "arg", call: "set_hook", line: 11, index: 0, from: { name: "$a" } }] }),
        fn("fire", 15, { valueFlow: [{ kind: "invoke", cell: { name: "g_hook" }, call: "g_hook", line: 16 }], calls: [call("g_hook", 16)] }),
      ],
    });
    expect(flowLinks([unit])).toEqual(["src/hook.c::fire@16 g_hook -> src/hook.c::on_kick"]);
  });
});

describe("value-flow: a call the facts cannot follow keeps the links it had (real-repo FP)", () => {
  /** Every link out of `symbol`, as `call -> file::target`. */
  const linksOf = (analyses: FileAnalysis[], symbol: string): string[] =>
    buildSymbolLinks(analyses)
      .filter((l) => l.sourceSymbol === symbol)
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();

  it("a plain name no fact writes (a wrapped callback) still links into its own file, never another's", () => {
    // `const refreshLeague = useCallback(() => …)` is a function of its own; the call is marked an invoke, yet no
    // fact writes `refreshLeague` — the value comes from a call the facts do not follow.
    const page = file("src/pages/LeaguePage.ts", {
      functions: [
        fn("LeaguePage", 1, { valueFlow: [{ kind: "invoke", cell: { name: "refreshLeague" }, call: "refreshLeague", line: 5 }], calls: [call("refreshLeague", 5)] }),
        fn("refreshLeague", 3),
      ],
    });
    expect(linksOf([page], "LeaguePage")).toEqual(["refreshLeague -> src/pages/LeaguePage.ts::refreshLeague"]);
    // The same when the only write is a call's result (`const reloadTable = debounce(loadTable, 50)`).
    const table = file("src/pages/TablePage.ts", {
      moduleValueFlow: [{ kind: "result", call: "debounce", line: 1, to: { name: "reloadTable" } }],
      functions: [
        fn("onSearch", 3, { valueFlow: [{ kind: "invoke", cell: { name: "reloadTable" }, call: "reloadTable", line: 4 }], calls: [call("reloadTable", 4)] }),
        fn("reloadTable", 1),
      ],
    });
    expect(linksOf([table], "onSearch")).toEqual(["reloadTable -> src/pages/TablePage.ts::reloadTable"]);
    // A closure local no fact writes never links into another file's namesake.
    const tests = file("src/league/table.test.ts", {
      functions: [fn("tableSorts", 1, { valueFlow: [{ kind: "invoke", cell: { name: "check" }, call: "check", line: 4 }], calls: [call("check", 4)] })],
    });
    const decoy = file("src/league/check.ts", { functions: [fn("check", 1)], exports: exp("check") });
    expect(linksOf([tests, decoy], "tableSorts")).toEqual([]);
  });

  it("a method called on a member no fact writes is left to the ordinary resolution", () => {
    const model = file("src/squad/selection.ts", { classes: [cls("SelectionModel", 1, [fn("apply", 3)])], exports: exp("SelectionModel") });
    const editor = file("src/squad/editor.ts", {
      imports: [imp("./selection", ["SelectionModel"])],
      classes: [cls("SquadEditor", 1, [
        fn("onOpen", 5, { valueFlow: [{ kind: "invoke", cell: { name: "this", member: "selectionModel" }, call: "this.selectionModel.apply", line: 6 }], calls: [call("this.selectionModel.apply", 6, { receiverType: "SelectionModel" } as Partial<CallInfo>)] }),
      ], [{ name: "selectionModel", type: "SelectionModel" }])],
    });
    expect(linksOf([model, editor], "SquadEditor.onOpen")).toEqual(["this.selectionModel.apply -> src/squad/selection.ts::SelectionModel.apply"]);
  });
});

describe("value-flow: a held lambda stands for at most four project functions, counted once resolved", () => {
  // `run(cb)` runs what it is handed; `go` hands it a lambda whose body calls the names below.
  const runner = file("src/run/runner.ts", {
    functions: [fn("run", 1, { params: [param("cb")], valueFlow: [{ kind: "invoke", cell: { name: "cb" }, call: "cb", line: 2 }], calls: [call("cb", 2, { boundLocally: true })] })],
    exports: exp("run"),
  });
  const decoy = file("src/other/decoys.ts", { functions: [fn("kickOff", 1)], exports: exp("kickOff") });
  const page = (names: string[], extra: ValueFlowFact[] = []) =>
    file("src/pages/MatchPage.ts", {
      imports: [imp("../run/runner", ["run"])],
      functions: [
        fn("kickOff", 1), fn("closeMatch", 3), fn("saveScore", 5), fn("notifyFans", 7), fn("refreshTable", 9),
        fn("go", 20, {
          calls: [call("run", 25, { kind: "cross-file", target: "../run/runner" })],
          valueFlow: [
            ...names.map((n): ValueFlowFact => ({ kind: "seed", to: { name: "<arg@25>" }, fn: n, line: 25, lambda: "25:8" })),
            ...extra,
            { kind: "arg", call: "run", line: 25, index: 0, from: { name: "<arg@25>" } },
          ],
        }),
      ],
    });
  const targets = (analyses: FileAnalysis[]): string[] => flowLinks(analyses).map((l) => l.split(" -> ")[1]!);

  it("counts only names that resolve: three project functions and three library names link the three", () => {
    const links = targets([runner, decoy, page(["kickOff", "closeMatch", "saveScore", "json.dumps", "log.info", "sleep"])]);
    expect(links).toEqual(["src/pages/MatchPage.ts::closeMatch", "src/pages/MatchPage.ts::kickOff", "src/pages/MatchPage.ts::saveScore"]);
  });

  it("states nothing for five project functions", () => {
    expect(targets([runner, decoy, page(["kickOff", "closeMatch", "saveScore", "notifyFans", "refreshTable"])])).toEqual([]);
  });

  it("counts the held values the lambda runs toward the four", () => {
    const copies: ValueFlowFact[] = [{ kind: "copy", from: { name: "onDone" }, to: { name: "<arg@25>" }, line: 25, lambda: "25:8" }];
    expect(targets([runner, decoy, page(["kickOff", "closeMatch", "saveScore"], copies)])).toHaveLength(3);
    expect(targets([runner, decoy, page(["kickOff", "closeMatch", "saveScore", "notifyFans"], copies)])).toEqual([]);
  });

  it("leaves facts without a lambda id as they were: five plain seeds still link", () => {
    const plain = page([]);
    const go = plain.functions.find((f) => f.name === "go")!;
    go.valueFlow = [
      ...["kickOff", "closeMatch", "saveScore", "notifyFans", "refreshTable"].map((n): ValueFlowFact => ({ kind: "seed", to: { name: "<arg@25>" }, fn: n, line: 25 })),
      { kind: "arg", call: "run", line: 25, index: 0, from: { name: "<arg@25>" } },
    ];
    expect(targets([runner, decoy, plain])).toHaveLength(5);
  });
});
