import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis } from "../types/analysis.js";

const fn = (name: string, line: number, calls: CallInfo[] = [], extra: Record<string, unknown> = {}) =>
  ({ name, line, endLine: line + 4, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [], ...extra });
const call = (name: string, line: number, kind: CallInfo["kind"], target: string | null = null): CallInfo => ({ name, kind, target, line });
const method = (name: string, line: number) => ({ ...fn(name, line), isExported: true });
const file = (filePath: string, o: { functions?: unknown[]; classes?: unknown[]; imports?: unknown[]; exports?: unknown[]; language?: string }): FileAnalysis =>
  ({ filePath, language: o.language ?? "typescript", projectId: "root", imports: o.imports ?? [], exports: o.exports ?? [], functions: o.functions ?? [], classes: o.classes ?? [], routes: [], dataSources: [] }) as unknown as FileAnalysis;
const cls = (name: string, line: number, methods: unknown[]) => ({ name, line, endLine: line + 20, methods, properties: [], decorators: [], implements: [], extends: null, isExported: true });

const named = (links: ReturnType<typeof buildSymbolLinks>, from: string) =>
  links.filter((l) => l.sourceFile === from && l.sourceSymbol !== "(reference)").map((l) => `${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`);

describe("a module reaches another module's class only through an import", () => {
  const map = file("src/map.ts", { classes: [cls("Map", 1, [method("set", 2)])], exports: [{ name: "Map", kind: "class", line: 1 }] });
  const response = file("src/http/response.ts", { classes: [cls("Response", 1, [method("json", 2)])], exports: [{ name: "Response", kind: "class", line: 1 }] });

  it("leaves `new Map()` and a `Response`-typed local to the globals they name", () => {
    const tally = file("src/tally.ts", {
      imports: [{ source: "./util", specifiers: ["round"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
      exports: [{ name: "tally", kind: "function", line: 3 }],
      functions: [fn("tally", 3, [call("new Map", 4, "internal")]), fn("load", 9, [call("r.json", 11, "internal")], { localTypes: [{ name: "r", type: "Response" }] })],
    });
    expect(named(buildSymbolLinks([map, response, tally]), "src/tally.ts")).toEqual([]);
  });

  it("still links the class a module imports, and the class a script uses", () => {
    const imported = file("src/tally.ts", {
      imports: [{ source: "./map", specifiers: ["Map"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
      exports: [{ name: "tally", kind: "function", line: 3 }],
      functions: [fn("tally", 3, [call("new Map", 4, "internal")])],
    });
    expect(named(buildSymbolLinks([map, imported]), "src/tally.ts")).toEqual(["tally -> src/map.ts::Map"]);
    // A script (no import, no export) shares the page's globals.
    const script = file("src/legacy.js", { language: "javascript", functions: [fn("boot", 1, [call("new Map", 2, "internal")])] });
    expect(named(buildSymbolLinks([map, script]), "src/legacy.js")).toEqual(["boot -> src/map.ts::Map"]);
  });

  it("keeps the lookup where a sub-project auto-imports its exports", () => {
    const nuxt = file("nuxt.config.ts", { exports: [{ name: "default", kind: "default", line: 1 }] });
    const page = file("src/tally.ts", {
      imports: [{ source: "vue", specifiers: ["ref"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
      functions: [fn("tally", 3, [call("new Map", 4, "internal")])],
    });
    expect(named(buildSymbolLinks([map, nuxt, page]), "src/tally.ts")).toEqual(["tally -> src/map.ts::Map"]);
  });
});

describe("a parameter shadows the import of its name", () => {
  it("calls the parameter, never the aliased import", () => {
    const journal = file("src/journal.ts", { functions: [fn("startJournal", 1)], exports: [{ name: "startJournal", kind: "function", line: 1 }] });
    const pipeline = file("src/pipeline.ts", {
      imports: [{ source: "./journal", specifiers: ["open"], aliases: { open: "startJournal" }, isDefault: false, isNamespace: false, isType: false, line: 1 }],
      functions: [
        fn("handleBatch", 3, [call("open", 4, "cross-file", "./journal")]),
        fn("run", 9, [call("open", 10, "cross-file", "./journal")], { params: [{ name: "open", type: "() => void", defaultValue: null }] }),
      ],
    });
    expect(named(buildSymbolLinks([journal, pipeline]), "src/pipeline.ts")).toEqual(["handleBatch -> src/journal.ts::startJournal"]);
  });
});
