import { describe, it, expect } from "vitest";
import { parseUnifiedHunks, reverseSymbolReach, symbolsInHunks } from "./changed-symbols.js";
import type { SymbolLink } from "../types/analysis.js";

describe("parseUnifiedHunks", () => {
  it("reads new-side ranges; a pure deletion is kept apart as the old-side lines removed", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,2 +3,4 @@ function x() {",
      "@@ -20 +22 @@",
      "@@ -30,3 +31,0 @@",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,5 +0,0 @@",
    ].join("\n");
    const hunks = parseUnifiedHunks(diff);
    expect([...hunks]).toEqual([["src/a.ts", [[3, 6], [22, 22]]]]);
    expect([...hunks.deleted!]).toEqual([["src/a.ts", [[30, 32]]]]);
    // Old-side ranges for symbol matching (edits + the pure deletion).
    expect([...hunks.old!]).toEqual([["src/a.ts", [[3, 4], [20, 20], [30, 32]]]]);
  });
});

describe("symbolsInHunks + reverseSymbolReach", () => {
  const analyses = new Map([
    ["svc.ts", {
      functions: [{ name: "helper", line: 1, endLine: 4 }, { name: "<setup>", line: 1, endLine: 40 }],
      classes: [{ name: "CarService", methods: [{ name: "place", line: 10, endLine: 20 }, { name: "cancel", line: 22, endLine: 30 }] }],
    } as never],
  ]);
  it("maps hunks to the innermost function, and lines outside any to the file", () => {
    const { symbols, moduleLevel } = symbolsInHunks(analyses, new Map([["svc.ts", [[12, 13], [35, 36]]], ["new.ts", [[1, 9]]]]));
    expect(symbols.map((s) => s.symbol)).toEqual(["CarService.place"]);
    expect(moduleLevel).toEqual(["new.ts", "svc.ts"]);
  });

  it("walks callers back, weakest link kept, routes included", () => {
    const link = (sf: string, ss: string, tf: string, ts: string, confidence: string): SymbolLink =>
      ({ sourceFile: sf, sourceSymbol: ss, sourceLine: 1, callName: ts, targetFile: tf, targetSymbol: ts, targetLine: 1, confidence } as SymbolLink);
    const callers = reverseSymbolReach([
      link("ctl.ts", "CarController.create", "svc.ts", "CarService.place", "EXTRACTED"),
      link("ctl.ts", "route:POST /cars", "ctl.ts", "CarController.create", "INFERRED"),
      link("other.ts", "unrelated", "svc.ts", "CarService.cancel", "EXTRACTED"),
    ], [{ file: "svc.ts", symbol: "CarService.place", line: 10, endLine: 20 }]);
    expect(callers.map((c) => [c.symbol, c.depth, c.confidence])).toEqual([
      ["CarController.create", 1, "EXTRACTED"],
      ["route:POST /cars", 2, "INFERRED"],
    ]);
  });
});

describe("an edit between the imports", () => {
  const club = {
    functions: [{ name: "promote", line: 10, endLine: 20 }],
    classes: [],
    imports: [{ line: 1 }, { line: 2 }, { line: 15 }],
  } as unknown as Parameters<typeof symbolsInHunks>[0] extends ReadonlyMap<string, infer V> ? V : never;
  it("is an import edit only within the top-level import lines, never stretched by an import inside a function", () => {
    expect(symbolsInHunks(new Map([["club.py", club]]), new Map([["club.py", [[2, 2]]]])).importOnly).toEqual(["club.py"]);
    // Line 5 is a module-level constant: the function-local import on line 15 must not make it an import edit.
    const found = symbolsInHunks(new Map([["club.py", club]]), new Map([["club.py", [[5, 5]]]]));
    expect(found.importOnly).toEqual([]);
    expect(found.moduleOnly).toEqual(["club.py"]);
  });
});

describe("signatureChanges", () => {
  const fn = (name: string, line: number, params: Array<[string, string | null]>) =>
    ({ name, line, endLine: line + 3, params: params.map(([n, d]) => ({ name: n, type: null, defaultValue: d })) });
  it("reports removals and required-parameter changes, breaking when a certain caller remains", async () => {
    const { signatureChanges } = await import("./changed-symbols.js");
    const before = new Map([["svc.ts", { functions: [fn("place", 1, [["car", null]]), fn("cancel", 10, [["id", null]]), fn("audit", 20, [["msg", null]]), fn("lonely", 30, [])], classes: [] } as never]]);
    const after = new Map([["svc.ts", { functions: [fn("place", 1, [["car", null], ["player", null]]), fn("cancel", 10, [])], classes: [] } as never]]);
    const link = (target: string) => ({ sourceFile: "ctl.ts", sourceSymbol: "c", sourceLine: 1, callName: target, targetFile: "svc.ts", targetSymbol: target, targetLine: 1, confidence: "EXTRACTED" }) as never;
    const out = signatureChanges(before, after, [link("place"), link("cancel"), link("audit")]);
    expect(out.map((c) => [c.symbol, c.kind, c.before ?? "", c.after ?? "", c.breaking])).toEqual([
      ["place", "arity", 1, 2, true],
      ["audit", "removed", "", "", true],
      ["cancel", "arity", 1, 0, false],
      ["lonely", "removed", "", "", false],
    ]);
  });

  it("says a removed function was possibly renamed, and breaks on a changed return type", async () => {
    const { signatureChanges, describeSignatureChange } = await import("./changed-symbols.js");
    const typed = (name: string, line: number, params: Array<[string, string]>, returnType: string | null) =>
      ({ name, line, endLine: line + 3, returnType, params: params.map(([n, t]) => ({ name: n, type: t, defaultValue: null })) });
    const before = new Map([["svc.ts", { functions: [
      typed("place", 1, [["car", "Car"]], "Receipt"),
      typed("find", 10, [["id", "string"]], "Car | null"),
      typed("drop", 20, [["id", "string"]], null),
    ], classes: [] } as never]]);
    const after = new Map([["svc.ts", { functions: [
      typed("placeCar", 1, [["car", "Car"]], "Receipt"),
      typed("find", 10, [["id", "string"]], "Car"),
      typed("dropAll", 20, [["ids", "string[]"]], null),
    ], classes: [] } as never]]);
    const link = (target: string) => ({ sourceFile: "ctl.ts", sourceSymbol: "c", sourceLine: 1, callName: target, targetFile: "svc.ts", targetSymbol: target, targetLine: 1, confidence: "EXTRACTED" }) as never;
    const out = signatureChanges(before, after, [link("place"), link("find")]);
    expect(out.map((c) => [c.symbol, describeSignatureChange(c), c.breaking])).toEqual([
      ["place", "removed (possibly renamed to placeCar)", true],
      ["find", "returns Car, was Car | null", true],
      // Different parameters: not the same function.
      ["drop", "removed", false],
    ]);
  });
});

describe("parameter types and visibility", () => {
  const fn = (name: string, line: number, params: Array<[string, string | null]>, isExported = true) =>
    ({ name, line, endLine: line + 3, isExported, returnType: null, params: params.map(([n, t]) => ({ name: n, type: t, defaultValue: null })) });
  const link = (sourceFile: string, target: string) =>
    ({ sourceFile, sourceSymbol: "c", sourceLine: 1, callName: target, targetFile: "garage.ts", targetSymbol: target, targetLine: 1, confidence: "EXTRACTED" }) as never;

  it("reports a parameter whose declared type changed at the same arity", async () => {
    const { signatureChanges, describeSignatureChange } = await import("./changed-symbols.js");
    const before = new Map([["garage.ts", { functions: [fn("park", 1, [["car", "Car"], ["bay", "number"]]), fn("wash", 10, [["car", null]]), fn("tow", 20, [["car", "Car"]])], classes: [] } as never]]);
    const after = new Map([["garage.ts", { functions: [fn("park", 1, [["car", "Car"], ["bay", "Bay"]]), fn("wash", 10, [["car", "Car"]]), fn("tow", 20, [["car", " Car "]])], classes: [] } as never]]);
    const out = signatureChanges(before, after, [link("pitlane.ts", "park")]);
    // `wash` gained a type it did not declare, `tow` only whitespace: neither is a change.
    expect(out.map((c) => [c.symbol, c.kind, describeSignatureChange(c), c.breaking])).toEqual([["park", "param-type", "takes bay: Bay, was bay: number", true]]);
  });

  it("reports a function no longer exported, breaking only callers in other files", async () => {
    const { signatureChanges, describeSignatureChange } = await import("./changed-symbols.js");
    const before = new Map([["garage.ts", { functions: [fn("park", 1, []), fn("wash", 10, [])], classes: [] } as never]]);
    const after = new Map([["garage.ts", { functions: [fn("park", 1, [], false), fn("wash", 10, [], false)], classes: [] } as never]]);
    const out = signatureChanges(before, after, [link("pitlane.ts", "park"), link("garage.ts", "wash")]);
    expect(out.map((c) => [c.symbol, c.kind, describeSignatureChange(c), c.breaking])).toEqual([
      ["park", "visibility", "no longer exported or public", true],
      ["wash", "visibility", "no longer exported or public", false],
    ]);
  });

  it("reads a public method made private off its class", async () => {
    const { signatureChanges } = await import("./changed-symbols.js");
    const cls = (methods: unknown[]) => ({ name: "Garage", kind: "class", methods, properties: [], line: 1, endLine: 20 });
    const before = new Map([["Garage.java", { functions: [], classes: [cls([fn("park", 2, [["car", "Car"]])])] } as never]]);
    const after = new Map([["Garage.java", { functions: [], classes: [cls([fn("park", 2, [["car", "Car"]], false)])] } as never]]);
    expect(signatureChanges(before, after, [])).toMatchObject([{ symbol: "Garage.park", kind: "visibility", breaking: false }]);
  });
});

describe("a function moved to another file", () => {
  const fn = (name: string, line: number, params: string[]) =>
    ({ name, line, endLine: line + 3, params: params.map((n) => ({ name: n, type: "Car", defaultValue: null })) });
  const link = (sourceFile: string, target: string, file = "garage.ts") =>
    ({ sourceFile, sourceSymbol: "c", sourceLine: 1, callName: target, targetFile: file, targetSymbol: target, targetLine: 1, confidence: "EXTRACTED" }) as never;

  it("is a move, breaking only the callers the change does not edit", async () => {
    const { signatureChanges, describeSignatureChange } = await import("./changed-symbols.js");
    const before = new Map([["garage.ts", { functions: [fn("park", 1, ["car"]), fn("wash", 10, ["car"])], classes: [] } as never]]);
    const after = new Map([
      ["garage.ts", { functions: [], classes: [] } as never],
      // New file: not in the stored analysis, so only on the after side.
      ["parking.ts", { functions: [fn("park", 1, ["car"])], classes: [] } as never],
      // A caller the change edits (its import now names parking.ts).
      ["pitlane.ts", { functions: [], classes: [] } as never],
    ]);
    const out = signatureChanges(before, after, [link("pitlane.ts", "park"), link("pitlane.ts", "wash")]);
    expect(out.map((c) => [c.symbol, c.kind, c.movedTo ?? "", describeSignatureChange(c), c.breaking])).toEqual([
      // Gone everywhere: still a removal, and its caller breaks even though the change edits it.
      ["wash", "removed", "", "removed", true],
      ["park", "moved", "parking.ts", "moved to parking.ts", false],
    ]);
    // A caller outside the change still imports the old file.
    const stranded = signatureChanges(before, after, [link("paddock.ts", "park")]);
    expect(stranded.find((c) => c.symbol === "park")).toMatchObject({ kind: "moved", breaking: true, callers: 1 });
  });

  it("is a removal when the twin differs in parameters, or two files gained it", async () => {
    const { signatureChanges } = await import("./changed-symbols.js");
    const before = new Map([["garage.ts", { functions: [fn("park", 1, ["car"]), fn("tow", 10, ["car"])], classes: [] } as never]]);
    const after = new Map([
      ["garage.ts", { functions: [], classes: [] } as never],
      ["parking.ts", { functions: [fn("park", 1, ["car", "bay"]), fn("tow", 10, ["car"])], classes: [] } as never],
      ["towing.ts", { functions: [fn("tow", 1, ["car"])], classes: [] } as never],
    ]);
    expect(signatureChanges(before, after, []).map((c) => [c.symbol, c.kind])).toEqual([
      ["park", "removed"],
      ["tow", "removed"],
    ]);
  });

  it("is a move for a method that keeps its class", async () => {
    const { signatureChanges } = await import("./changed-symbols.js");
    const cls = (name: string, methods: unknown[]) => ({ name, kind: "class", methods, properties: [], line: 1, endLine: 20 });
    const before = new Map([["Garage.java", { functions: [], classes: [cls("Garage", [fn("park", 2, ["car"])])] } as never]]);
    const after = new Map([
      ["Garage.java", { functions: [], classes: [] } as never],
      ["parking/Garage.java", { functions: [], classes: [cls("Garage", [fn("park", 2, ["car"])])] } as never],
    ]);
    expect(signatureChanges(before, after, [])).toMatchObject([{ symbol: "Garage.park", kind: "moved", movedTo: "parking/Garage.java", breaking: false }]);
  });
});

describe("an edit not made yet", () => {
  it("reads old-side ranges, a pure insertion as the line it follows", () => {
    const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -3,2 +3,4 @@", "@@ -9,0 +12,3 @@", "@@ -20 +24 @@"].join("\n");
    expect([...parseUnifiedHunks(diff, "old")]).toEqual([["src/a.ts", [[3, 4], [9, 9], [20, 20]]]]);
  });

  it("judges proposed content against the file as it is: its changed lines and its parsed signatures", async () => {
    const { mkdtemp, rm, writeFile, mkdir } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { proposedHunks, analyzeWorkingFiles } = await import("./changed-symbols.js");
    const root = await mkdtemp(join(tmpdir(), "clarifydoc-proposed-"));
    try {
      await mkdir(join(root, "src"));
      const now = ["export function a(x: number) {", "  return x;", "}", "", "export function b() {", "  return 2;", "}", ""].join("\n");
      await writeFile(join(root, "src", "m.ts"), now);
      const next = now.replace("  return 2;", "  return 3;").replace("export function a(x: number) {", "export function a(x: number, y: number) {");
      const hunks = await proposedHunks(root, new Map([["src/m.ts", next], ["src/new.ts", "export const n = 1;\n"]]));
      // Two separate edits, in today's line numbers; a file that does not exist yet has none.
      expect([...hunks]).toEqual([["src/m.ts", [[1, 1], [6, 6]]]]);
      const after = await analyzeWorkingFiles(root, ["src/m.ts", "src/gone.ts"], new Map([["src/m.ts", next], ["src/gone.ts", null]]));
      expect(after.get("src/m.ts")!.functions.find((f) => f.name === "a")!.params.map((p) => p.name)).toEqual(["x", "y"]);
      expect(after.get("src/gone.ts")).toEqual({ functions: [], classes: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("what a signature change leaves broken besides its callers", () => {
  const typed = (name: string, line: number, params: Array<[string, string]>, isExported = true) =>
    ({ name, line, endLine: line + 3, returnType: null, isExported, params: params.map(([n, t]) => ({ name: n, type: t, defaultValue: null })) });
  const importer = (file: string, target: string) =>
    ({ sourceFile: file, sourceSymbol: "(reference)", sourceLine: 1, callName: target, targetFile: "garage.ts", targetSymbol: target, targetLine: 1, confidence: "EXTRACTED", strategy: "reference", relation: "reference" }) as never;

  it("breaks on an export removed or hidden while another file imports it, though nothing calls it", async () => {
    const { signatureChanges, signatureChangeTail } = await import("./changed-symbols.js");
    const before = new Map([["garage.ts", { functions: [typed("park", 1, []), typed("wash", 10, []), typed("refuel", 20, [])], classes: [] } as never]]);
    const after = new Map([["garage.ts", { functions: [typed("wash", 10, [], false), typed("refuel", 20, [])], classes: [] } as never]]);
    const out = signatureChanges(before, after, [importer("pitlane.ts", "park"), importer("paddock.ts", "park"), importer("pitlane.ts", "wash"), importer("garage.ts", "refuel")]);
    expect(out.map((c) => [c.symbol, c.kind, c.callers, c.importers, c.breaking])).toEqual([
      ["park", "removed", 0, 2, true],
      ["wash", "visibility", 0, 1, true],
    ]);
    expect(signatureChangeTail(out[0]!)).toBe("imported by 2 files");
  });

  it("lists the overrides still declaring the old signature, and breaks on them", async () => {
    const { signatureChanges, signatureChangeTail } = await import("./changed-symbols.js");
    const car = (params: Array<[string, string]>) => ({ functions: [], classes: [{ name: "Car", methods: [typed("start", 3, params)] }] }) as never;
    const sports = (params: Array<[string, string]>) => ({ functions: [], classes: [{ name: "SportsCar", methods: [typed("start", 5, params)] }] }) as never;
    const overrides = new Map([["car.ts::Car.start", [{ file: "sports-car.ts", symbol: "SportsCar.start", line: 5 }, { file: "truck.ts", symbol: "Truck.start", line: 7 }]]]);
    const before = new Map([["car.ts", car([["gear", "number"]])], ["sports-car.ts", sports([["gear", "number"]])]]);
    // The change gives Car.start a second parameter and updates SportsCar; Truck (a file it leaves alone) keeps the old one.
    const after = new Map([["car.ts", car([["gear", "number"], ["driver", "Driver"]])], ["sports-car.ts", sports([["g", "number"], ["d", "Driver"]])]]);
    const [change] = signatureChanges(before, after, [], { overrides });
    expect(change).toMatchObject({ symbol: "Car.start", kind: "arity", callers: 0, breaking: true, staleOverrides: [{ symbol: "Truck.start", file: "truck.ts", line: 7 }] });
    expect(signatureChangeTail(change!)).toBe("overridden by Truck.start (truck.ts:7), still on the old signature");
    // An override the change left on the old parameters, in a file it did touch, is stale too.
    const half = new Map([["car.ts", car([["gear", "number"], ["driver", "Driver"]])], ["sports-car.ts", sports([["speed", "number"]])]]);
    expect(signatureChanges(before, half, [], { overrides })[0]!.staleOverrides?.map((o) => o.symbol)).toEqual(["SportsCar.start", "Truck.start"]);
  });

  it("parses an extension-less script by its #! line, where discovery would read one", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { analyzeWorkingFiles } = await import("./changed-symbols.js");
    const root = await mkdtemp(join(tmpdir(), "clarifydoc-script-"));
    try {
      await mkdir(join(root, "bin"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      const script = "#!/usr/bin/env python3\n\ndef kick_off():\n    return 1\n";
      await writeFile(join(root, "bin/serve"), script);
      await writeFile(join(root, "bin/README"), "def kick_off():\n    return 1\n"); // no #! line
      await writeFile(join(root, "src/lineup"), script); // not where discovery reads scripts
      const names = (m: Map<string, { functions: Array<{ name: string }> }>) =>
        Object.fromEntries([...m].map(([f, s]) => [f, s.functions.map((fn) => fn.name).filter((n) => n !== "<setup>")]));
      expect(names(await analyzeWorkingFiles(root, ["bin/serve", "bin/README", "src/lineup"]))).toEqual({ "bin/serve": ["kick_off"] });
      // A proposed version is judged by its own first line, and a proposed deletion empties the script.
      const proposed = new Map<string, string | null>([["bin/fixtures", script.replace("kick_off", "fixtures")], ["bin/serve", null]]);
      expect(names(await analyzeWorkingFiles(root, ["bin/fixtures", "bin/serve"], proposed))).toEqual({ "bin/fixtures": ["fixtures"], "bin/serve": [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips a deleted file without trying to parse it", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { vi } = await import("vitest");
    const { analyzeWorkingFiles } = await import("./changed-symbols.js");
    const root = await mkdtemp(join(tmpdir(), "clarifydoc-deleted-"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const after = await analyzeWorkingFiles(root, ["src/garage.ts"]);
      expect([...after]).toEqual([["src/garage.ts", { functions: [], classes: [] }]]);
      expect([...errors.mock.calls, ...logs.mock.calls].flat().join("\n")).not.toMatch(/ENOENT|Error analyzing/);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("module-level names: an edit on one is an edit of that name", () => {
  const settings = {
    functions: [{ name: "table", line: 10, endLine: 12 }],
    classes: [],
    imports: [{ line: 1 }, { line: 8 }],
    moduleNames: [
      { name: "SEASON_LIMIT", line: 3, endLine: 5 },
      { name: "league_router", line: 6, endLine: 9 },
    ],
  };
  const run = (ranges: Array<[number, number]>) => symbolsInHunks(new Map([["settings.py", settings as never]]), new Map([["settings.py", ranges]]));

  it("a hunk inside a name's lines names it and leaves the file out of moduleLevel", () => {
    const found = run([[4, 4]]);
    expect([...found.bound]).toEqual([["settings.py", ["SEASON_LIMIT"]]]);
    expect(found.moduleLevel).toEqual([]);
    expect(found.moduleOnly).toEqual([]);
  });

  it("a constant written between two top-level imports is a constant, not an import edit", () => {
    const found = run([[4, 4]]);
    expect(found.importOnly).toEqual([]);
  });

  it("a hunk spanning two names names both; one reaching a line no name owns keeps the file moduleOnly", () => {
    expect([...run([[4, 7]]).bound]).toEqual([["settings.py", ["SEASON_LIMIT", "league_router"]]]);
    const loose = run([[4, 4], [13, 14]]);
    expect(loose.moduleOnly).toEqual(["settings.py"]);
    const hole = run([[13, 14]]);
    expect(hole.bound.size).toBe(0);
    expect(hole.moduleOnly).toEqual(["settings.py"]);
    expect(run([[1, 1]]).importOnly).toEqual(["settings.py"]);
  });
});

describe("boundReaders", () => {
  const imp = (source: string, specifiers: string[], extra: object = {}) => ({ source, specifiers, isDefault: false, isNamespace: false, isType: false, line: 1, ...extra });
  const write = async (dir: string, files: Record<string, object>) => {
    const { mkdir, writeFile } = await import("fs/promises");
    const { dirname, join } = await import("path");
    for (const [f, a] of Object.entries(files)) {
      await mkdir(dirname(join(dir, `${f}.json`)), { recursive: true });
      await writeFile(join(dir, `${f}.json`), JSON.stringify(a));
    }
  };

  it("charges importers that name the edited name or take the module whole, never one that imports another name", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { boundReaders } = await import("./changed-symbols.js");
    const dir = await mkdtemp(join(tmpdir(), "bound-readers-"));
    try {
      await write(dir, {
        "pkg/named.py": { imports: [imp("pkg.settings", ["SEASON_LIMIT"])] },
        "pkg/whole.py": { imports: [imp("pkg", ["settings"])] },
        "pkg/other.py": { imports: [imp("pkg.settings", ["OTHER_LIMIT"])] },
        "pkg/fn.py": { imports: [imp("pkg.settings", ["table"]), imp("os", [])] },
        "pkg/star.py": { imports: [imp("pkg.settings", ["*"])] },
        "pkg/__init__.py": { imports: [imp("pkg.settings", ["SEASON_LIMIT"])], exports: [{ name: "SEASON_LIMIT", kind: "re-export", line: 1 }] },
        "app/user.py": { imports: [imp("pkg", ["SEASON_LIMIT"])] },
        "app/decoy.py": { imports: [imp("pkg", ["table"])] },
        "pkg/aliased.py": { imports: [imp("pkg.settings", ["cfg"], { isNamespace: true })] },
        "pkg/by_inheritance.py": { imports: [imp("os", [])] },
      });
      const graph = {
        "pkg/named.py": ["pkg/settings.py"],
        "pkg/whole.py": ["pkg/settings.py"],
        "pkg/other.py": ["pkg/settings.py"],
        "pkg/fn.py": ["pkg/settings.py"],
        "pkg/star.py": ["pkg/settings.py"],
        "pkg/__init__.py": ["pkg/settings.py"],
        "app/user.py": ["pkg/__init__.py"],
        "app/decoy.py": ["pkg/__init__.py"],
        "pkg/aliased.py": ["pkg/settings.py"],
        "pkg/by_inheritance.py": ["pkg/settings.py"],
      };
      const out = await boundReaders(dir, { componentGraph: graph }, new Map([["pkg/settings.py", ["SEASON_LIMIT"]]]));
      // The two-hop reader (through the package's re-export) is charged; importers of other names of the module are not.
      expect(out["pkg/settings.py"]).toEqual([
        "app/decoy.py", // reaches the package file, whose own name no import row spells: kept
        "app/user.py",
        "pkg/__init__.py",
        "pkg/aliased.py", // `import pkg.settings as cfg`: the module whole
        "pkg/by_inheritance.py", // an edge no import row spells: nothing says it does not read the name
        "pkg/named.py",
        "pkg/star.py",
        "pkg/whole.py",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
