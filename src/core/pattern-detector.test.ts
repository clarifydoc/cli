import { describe, it, expect } from "vitest";
import { detectPatterns } from "./pattern-detector.js";
import { createEmptyAnalysis, type FileAnalysis, type PatternInfo } from "../types/analysis.js";

/**
 * God-object detection must not count trivial accessors: a Java/C# entity
 * with 20 hand-written getters/setters is a data holder, not a god object.
 */
const method = (name: string, line: number, endLine: number, params = 1) => ({
  name,
  line,
  endLine,
  params: Array.from({ length: params }, (_, i) => ({ name: `p${i}`, type: null, defaultValue: null })),
  returnType: null,
  isAsync: false,
  isExported: true,
  calls: [],
  decorators: [],
});

const fileWith = (methods: ReturnType<typeof method>[]): FileAnalysis =>
  ({
    filePath: "src/DriverEntity.java",
    language: "java",
    functions: [],
    classes: [{
      name: "DriverEntity", kind: "class", extends: null, implements: [],
      decorators: [], methods, properties: [], line: 1, endLine: 200,
    }],
    imports: [], exports: [], routes: [], dataSources: [], events: [],
    interactiveElements: [], subComponents: [],
  } as unknown as FileAnalysis);

describe("god-object accessor exclusion", () => {
  it("does NOT flag an entity whose bulk is 2-line getters/setters", () => {
    const accessors = Array.from({ length: 20 }, (_, i) =>
      method(i % 2 ? `getField${i}` : `setField${i}`, 10 + i * 3, 11 + i * 3),
    );
    const real = Array.from({ length: 4 }, (_, i) => method(`compute${i}`, 100 + i * 10, 108 + i * 10));
    const patterns = detectPatterns([fileWith([...accessors, ...real])], []);
    expect(patterns.some((p) => p.kind === "god-object")).toBe(false);
  });

  it("still flags a file with 16+ substantive methods", () => {
    const real = Array.from({ length: 17 }, (_, i) => method(`handleCase${i}`, 10 + i * 10, 18 + i * 10));
    const patterns = detectPatterns([fileWith(real)], []);
    expect(patterns.some((p) => p.kind === "god-object")).toBe(true);
  });

  it("counts a long getter as substantive (only ≤3-line accessors are exempt)", () => {
    const longGetters = Array.from({ length: 16 }, (_, i) => method(`getDerived${i}`, 10 + i * 12, 19 + i * 12));
    const patterns = detectPatterns([fileWith(longGetters)], []);
    expect(patterns.some((p) => p.kind === "god-object")).toBe(true);
  });
});

describe("god-object grading uses internal structure", () => {
  // Counting functions alone put a cohesive parser and a service mixing four
  // concerns in the same bucket with the same "split by responsibility" advice.
  const manyFunctions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `fn${i}`, params: [{ name: "a", type: null, defaultValue: null }, { name: "b", type: null, defaultValue: null }],
      returnType: null, isAsync: false, isExported: true, decorators: [], calls: [],
      line: i * 5 + 1, endLine: i * 5 + 4,
    }));

  const analysisWith = (path: string, n: number): FileAnalysis =>
    ({ ...createEmptyAnalysis(path, "typescript"), functions: manyFunctions(n) });

  const god = (patterns: PatternInfo[]) => patterns.find((p) => p.kind === "god-object")!;

  it("grades separable work high", () => {
    const p = detectPatterns([analysisWith("svc.ts", 20)], [], new Map([
      ["svc.ts", { componentSizes: [8, 7, 5], participation: 1, boundaries: 4 }],
    ]));
    expect(god(p).confidence).toBe("high");
    expect(god(p).detail).toMatch(/separable work/);
  });

  it("grades one cohesive group with no boundaries low", () => {
    const p = detectPatterns([analysisWith("parser.ts", 20)], [], new Map([
      ["parser.ts", { componentSizes: [19, 1], participation: 1, boundaries: 0 }],
    ]));
    expect(god(p).confidence).toBe("low");
    expect(god(p).detail).toMatch(/large but cohesive/);
  });

  it("says so when too little is connected to judge", () => {
    const p = detectPatterns([analysisWith("misc.ts", 20)], [], new Map([
      ["misc.ts", { componentSizes: [3, 1, 1, 1], participation: 0.2, boundaries: 1 }],
    ]));
    expect(god(p).confidence).toBe("medium");
    expect(god(p).detail).toMatch(/internal structure is unclear/);
  });

  it("falls back to the count when no structure is supplied", () => {
    const p = detectPatterns([analysisWith("legacy.ts", 20)], []);
    expect(god(p).confidence).toBe("medium");
    expect(god(p).detail).toMatch(/Structure unknown/);
  });
});
