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
