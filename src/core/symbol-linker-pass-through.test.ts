import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, ClassInfo, FileAnalysis, FunctionInfo, ParamInfo } from "../types/analysis.js";

/**
 * A generic function returning the type of one of its parameters (`identity<T>(c: T): T`) hands back the type of the
 * argument — the call chained on it is a member of that argument's class. Hand-built analyses, as plugins emit them.
 */

const call = (name: string, line = 10, o: Partial<CallInfo> = {}): CallInfo => ({ name, kind: "internal", target: null, line, ...o });
const param = (name: string, type: string): ParamInfo => ({ name, type, defaultValue: null });
const fn = (name: string, line: number, calls: CallInfo[] = [], params: ParamInfo[] = [], returnType: string | null = null): FunctionInfo =>
  ({ name, line, endLine: line, params, calls, returnType, isAsync: false, isExported: true, decorators: [] });
const cls = (name: string, methods: FunctionInfo[]): ClassInfo =>
  ({ name, kind: "class", extends: null, implements: [], methods, properties: [], decorators: [], isExported: true, line: 1, endLine: 20 });
const file = (filePath: string, classes: ClassInfo[], functions: FunctionInfo[] = [], imports: FileAnalysis["imports"] = []): FileAnalysis =>
  ({ filePath, projectId: "root", language: "typescript", functions, classes, imports, exports: [], routes: [], dataSources: [] } as unknown as FileAnalysis);

describe("pass-through generic functions", () => {
  const analyses = (): FileAnalysis[] => [
    file("lib/club.ts", [cls("Club", [fn("promote", 2)])]),
    file("lib/player.ts", [cls("Player", [fn("promote", 2)])]),
    file("lib/util.ts", [], [fn("identity", 1, [], [param("c", "T")], "T")]),
    file("page.ts", [], [
      fn("go", 3, [
        call("identity(club).promote", 4),
        call("identity", 4, { kind: "cross-file", target: "./lib/util" }),
      ], [param("club", "Club")]),
    ], [{ source: "./lib/util", specifiers: ["identity"], isDefault: false, isNamespace: false, isType: false, line: 1 }]),
  ];
  const chain = (a: FileAnalysis[]) =>
    buildSymbolLinks(a).filter((l) => l.sourceSymbol === "go" && l.callName === "identity(club).promote").map((l) => `${l.targetFile}:${l.targetSymbol}`);

  it("types the chain by the argument's declared type, never a namesake class", () => {
    expect(chain(analyses())).toEqual(["lib/club.ts:Club.promote"]);
  });

  it("an argument the caller does not type leaves the chain unresolved", () => {
    const a = analyses();
    a[3]!.functions[0]!.params = [];
    expect(chain(a)).toEqual([]);
  });
});
