import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis, FunctionInfo, SymbolLink } from "../types/analysis.js";

const call = (name: string, line: number, extra: Partial<CallInfo> = {}): CallInfo => ({ name, kind: "internal", target: null, line, ...extra });

const fn = (name: string, line: number, endLine: number, calls: CallInfo[] = [], extra: Partial<FunctionInfo> = {}): FunctionInfo =>
  ({ name, line, endLine, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [], ...extra });

const cls = (name: string, line: number, endLine: number, methods: FunctionInfo[]) =>
  ({ name, kind: "class", extends: null, implements: [], methods, properties: [], decorators: [], line, endLine });

const file = (filePath: string, language: string, opts: { functions?: FunctionInfo[]; classes?: unknown[] }): FileAnalysis =>
  ({
    filePath,
    projectId: "root",
    language,
    functions: opts.functions ?? [],
    classes: opts.classes ?? [],
    imports: [],
    exports: [],
    routes: [],
    dataSources: [],
  } as unknown as FileAnalysis);

const from = (links: SymbolLink[], sourceSymbol: string, callName: string) =>
  links.filter((l) => l.sourceSymbol === sourceSymbol && l.callName === callName);

describe("symbol-linker — unique-global counts definitions, not files", () => {
  // `foreach (var p in squad) p.Drill()`: the element's type is not tracked,
  // and the file declaring the name declares it twice.
  it("leaves a call unlinked when two classes of one file declare the method (C#)", () => {
    const decl = file("League/Coaching.cs", "csharp", {
      classes: [cls("Coach", 1, 3, [fn("Drill", 2, 2)]), cls("Player", 4, 6, [fn("Drill", 5, 5)])],
    });
    const caller = file("League/Training.cs", "csharp", {
      classes: [cls("Training", 1, 9, [fn("Run", 2, 8, [call("p.Drill", 6)])])],
    });
    expect(from(buildSymbolLinks([decl, caller]), "Training.Run", "p.Drill")).toEqual([]);
  });

  it("leaves `x.start()` unlinked when two classes of one module declare `start` (Python)", () => {
    const decl = file("machines.py", "python", {
      classes: [cls("Engine", 1, 3, [fn("start", 2, 3)]), cls("Pump", 6, 8, [fn("start", 7, 8)])],
    });
    const caller = file("runner.py", "python", { functions: [fn("run", 4, 5, [call("x.start", 5)])] });
    expect(from(buildSymbolLinks([decl, caller]), "run", "x.start")).toEqual([]);
  });

  it("still links the one class declaring the method (control)", () => {
    const decl = file("League/Coaching.cs", "csharp", {
      classes: [cls("Coach", 1, 3, [fn("Drill", 2, 2)]), cls("Player", 4, 6, [fn("Sprint", 5, 5)])],
    });
    const caller = file("League/Training.cs", "csharp", {
      classes: [cls("Training", 1, 9, [fn("Run", 2, 8, [call("p.Drill", 6)])])],
    });
    const [link] = from(buildSymbolLinks([decl, caller]), "Training.Run", "p.Drill");
    expect(link).toMatchObject({ targetFile: "League/Coaching.cs", targetSymbol: "Coach.Drill", strategy: "unique-global" });
  });
});
