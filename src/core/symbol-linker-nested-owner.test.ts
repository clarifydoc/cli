import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, ClassInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";

/**
 * `Right.Builder.build()`: a call through the owner path of a nested type reaches the member of the class
 * nested in `Right`'s body, never a namesake nested in `Left`. Hand-built analyses, as the plugins emit them.
 */

const call = (name: string, line: number): CallInfo => ({ name, kind: "internal", target: null, line });

const fn = (name: string, line: number, calls: CallInfo[] = []): FunctionInfo =>
  ({ name, line, endLine: line + 1, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [] });

const cls = (name: string, line: number, endLine: number, methods: FunctionInfo[] = []): ClassInfo =>
  ({ name, kind: "class", extends: null, implements: [], methods, properties: [], decorators: [], isExported: true, line, endLine });

const file = (filePath: string, language: string, classes: ClassInfo[]): FileAnalysis =>
  ({ filePath, projectId: "root", language, functions: [], classes, imports: [], exports: [], routes: [], dataSources: [] } as unknown as FileAnalysis);

const owner = (name: string, language: string, member: string) =>
  file(`${name}.${language === "java" ? "java" : "cs"}`, language, [
    cls(name, 1, 12),
    cls("Builder", 3, 10, [fn(member, 5)]),
  ]);

const links = (analyses: FileAnalysis[]) =>
  buildSymbolLinks(analyses).filter((l) => l.relation !== "reference").map((l) => `${l.callName} -> ${l.targetFile}:${l.targetSymbol}:${l.targetLine} [${l.strategy}]`);

describe("calls through a nested type's owner path", () => {
  for (const [language, ext, method, only] of [["java", "java", "build", "only"], ["csharp", "cs", "Build", "Only"]] as const) {
    const garage = (callName: string) => file(`Garage.${ext}`, language, [cls("Garage", 1, 9, [fn("go", 3, [call(callName, 4)])])]);

    it(`${language}: reaches Right's Builder, not Left's, when both declare the member`, () => {
      expect(links([owner("Left", language, method), owner("Right", language, method), garage(`Right.Builder.${method}`)]))
        .toEqual([`Right.Builder.${method} -> Right.${ext}:Builder.${method}:5 [class-name]`]);
    });

    it(`${language}: never takes the namesake's member when the named owner's nested type lacks it`, () => {
      const right = file(`Right.${ext}`, language, [cls("Right", 1, 12), cls("Builder", 3, 10, [fn("other", 5)])]);
      const found = links([owner("Left", language, only), right, garage(`Right.Builder.${only}`)]);
      expect(found.filter((l) => l.includes(`Left.${ext}`))).toEqual([]);
    });

    it(`${language}: two nested types of one name in one file are told apart by the owner`, () => {
      const both = file(`Both.${ext}`, language, [
        cls("Left", 1, 10), cls("Builder", 2, 9, [fn(method, 4)]),
        cls("Right", 11, 20), cls("Builder", 12, 19, [fn(method, 14)]),
      ]);
      const found = links([both, garage(`Right.Builder.${method}`)]);
      expect(found).toHaveLength(1);
      for (const l of found) expect(Number(/:(\d+) \[/.exec(l)![1])).toBeGreaterThanOrEqual(12);
    });
  }
});

describe("calls through a nested type's owner path: generated classes and inherited owners", () => {
  for (const [language, ext, method] of [["java", "java", "build"], ["csharp", "cs", "Build"]] as const) {
    const garage = (callName: string) => file(`Garage.${ext}`, language, [cls("Garage", 1, 9, [fn("go", 3, [call(callName, 4)])])]);
    const derby = file(`Derby.${ext}`, language, [{ ...cls("Derby", 1, 2), extends: "Match" }]);
    const match = file(`Match.${ext}`, language, [cls("Match", 1, 12), cls("Result", 3, 10, [fn(method, 5)])]);
    const other = file(`Other.${ext}`, language, [cls("Other", 1, 12), cls("Result", 3, 10, [fn(method, 5)])]);

    it(`${language}: a nested type the owner inherits from its base is reached, not a namesake of an unrelated class`, () => {
      expect(links([derby, match, other, garage(`Derby.Result.${method}`)]))
        .toEqual([`Derby.Result.${method} -> Match.${ext}:Result.${method}:5 [class-name]`]);
    });

    it(`${language}: a path neither the owner nor its bases bear out links nowhere`, () => {
      expect(links([derby, match, other, garage(`Derby.Missing.${method}`)])).toEqual([]);
    });
  }

  it("java: a generated class's stated owner path is reached through the call-chain walk", () => {
    const club = file("Club.java", "java", [
      cls("Club", 1, 2),
      { ...cls("Club_Builder", 2, 2, [fn("build", 2)]), nestedPath: "Club.Builder", synthetic: true },
    ]);
    const garage = file("Garage.java", "java", [cls("Garage", 1, 9, [fn("go", 3, [call("Club.Builder.build", 4)])])]);
    expect(links([club, garage])).toEqual(["Club.Builder.build -> Club.java:Club_Builder.build:2 [class-name]"]);
  });
});
