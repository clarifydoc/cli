import { describe, it, expect } from "vitest";
import { buildSiblingGraph, sameFileLinksByFile } from "./sibling-graph.js";
import { createEmptyAnalysis, type FileAnalysis, type SymbolLink } from "../types/analysis.js";

/**
 * Same-file call edges are extracted and persisted but nothing read them: the
 * project graph skips them by construction (a file does not import itself). So
 * "does this file hold one piece of logic or several" had never been asked.
 */
const fn = (name: string, line: number, endLine: number) => ({
  name, params: [], returnType: null, isAsync: false, isExported: false,
  decorators: [], calls: [], line, endLine,
});

function file(path: string, names: Array<[string, number, number]>): FileAnalysis {
  const a = createEmptyAnalysis(path, "typescript");
  for (const [n, l, e] of names) a.functions.push(fn(n, l, e));
  return a;
}

const link = (file: string, from: string, to: string): SymbolLink => ({
  sourceFile: file, sourceSymbol: from, sourceLine: 1,
  callName: to, targetFile: file, targetSymbol: to, targetLine: 1,
});

describe("buildSiblingGraph", () => {
  const a = file("m.ts", [["a", 1, 5], ["b", 7, 11], ["c", 13, 17], ["x", 20, 24], ["y", 26, 30]]);

  it("finds two independent groups", () => {
    const g = buildSiblingGraph(a, [link("m.ts", "a", "b"), link("m.ts", "b", "c"), link("m.ts", "x", "y")])!;
    expect(g.components).toEqual([["a", "b", "c"], ["x", "y"]]);
    expect(g.participation).toBe(1);
  });

  it("reports one group when everything is connected", () => {
    const g = buildSiblingGraph(a, [
      link("m.ts", "a", "b"), link("m.ts", "b", "c"), link("m.ts", "c", "x"), link("m.ts", "x", "y"),
    ])!;
    expect(g.components).toHaveLength(1);
  });

  it("counts an isolated function as its own group and lowers participation", () => {
    const g = buildSiblingGraph(a, [link("m.ts", "a", "b")])!;
    expect(g.components[0]).toEqual(["a", "b"]);
    expect(g.components).toHaveLength(4); // a+b, then c, x, y alone
    expect(g.participation).toBeCloseTo(0.4, 5);
  });

  it("drops self-loops, which are recursion or a name collision, not structure", () => {
    const g = buildSiblingGraph(a, [link("m.ts", "a", "a")])!;
    expect(g.edges).toEqual([]);
    expect(g.participation).toBe(0);
  });

  it("ignores synthesized route entries and reverse-reference markers", () => {
    const g = buildSiblingGraph(a, [
      link("m.ts", "route:GET /x", "a"),
      link("m.ts", "(reference)", "b"),
      link("m.ts", "a", "b"),
    ])!;
    expect(g.edges).toEqual([{ from: "a", to: "b" }]);
  });

  it("deduplicates repeated edges", () => {
    const g = buildSiblingGraph(a, [link("m.ts", "a", "b"), link("m.ts", "a", "b")])!;
    expect(g.edges).toHaveLength(1);
  });

  it("returns undefined for a file that declares no functions", () => {
    expect(buildSiblingGraph(createEmptyAnalysis("empty.ts", "typescript"), [])).toBeUndefined();
  });

  it("orders deterministically regardless of link order", () => {
    const links = [link("m.ts", "x", "y"), link("m.ts", "b", "c"), link("m.ts", "a", "b")];
    const forward = buildSiblingGraph(a, links)!;
    const reversed = buildSiblingGraph(a, [...links].reverse())!;
    expect(reversed.components).toEqual(forward.components);
  });
});

describe("sameFileLinksByFile", () => {
  it("keeps only links whose source and target file match", () => {
    const grouped = sameFileLinksByFile([
      link("m.ts", "a", "b"),
      { ...link("m.ts", "a", "b"), targetFile: "other.ts" },
    ]);
    expect(grouped.get("m.ts")).toHaveLength(1);
  });
});
