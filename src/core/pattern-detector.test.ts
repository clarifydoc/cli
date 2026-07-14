import { describe, it, expect } from "vitest";
import { detectPatterns } from "./pattern-detector.js";
import type { FileAnalysis } from "../types/analysis.js";

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
    filePath: "src/CustomerEntity.java",
    language: "java",
    functions: [],
    classes: [{
      name: "CustomerEntity", kind: "class", extends: null, implements: [],
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
