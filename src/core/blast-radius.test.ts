import { describe, it, expect } from "vitest";
import { analyzeBlastRadius } from "./blast-radius.js";
import type { SymbolLink } from "../types/analysis.js";

const link = (
  sf: string,
  ss: string,
  tf: string,
  ts: string,
  sourceLine = 1,
): SymbolLink => ({
  sourceFile: sf,
  sourceSymbol: ss,
  sourceLine,
  callName: ts,
  targetFile: tf,
  targetSymbol: ts,
  targetLine: 1,
});

describe("analyzeBlastRadius — dependency traversal", () => {
  // a → b → c   (a imports b, b imports c)
  const graph = { "a.ts": ["b.ts"], "b.ts": ["c.ts"] };

  it("computes direct and transitive dependents with depth decay", () => {
    const results = analyzeBlastRadius(graph, [], 3);
    const c = results.find((r) => r.filePath === "c.ts")!;
    expect(c.affectedFiles).toEqual(["b.ts"]);
    expect(c.directDependents).toBe(1);
    expect(c.transitiveFiles).toEqual(["a.ts"]);
    expect(c.transitiveDependents).toBe(1);
    // impactScore = 1 direct + 1/(1+1) decay for the depth-2 dependent
    expect(c.impactScore).toBe(1.5);
    expect(c.maxDepth).toBe(2);
  });

  it("records outbound dependencies as fragility", () => {
    const results = analyzeBlastRadius(graph, [], 3);
    const a = results.find((r) => r.filePath === "a.ts")!;
    expect(a.dependsOn).toEqual(["b.ts"]);
    expect(a.directDependents).toBe(0);
  });

  it("sorts results by impact score descending", () => {
    const results = analyzeBlastRadius(graph, [], 3);
    const scores = results.map((r) => r.impactScore);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it("terminates on cyclic graphs", () => {
    const results = analyzeBlastRadius({ "a.ts": ["b.ts"], "b.ts": ["a.ts"] }, [], 2);
    const a = results.find((r) => r.filePath === "a.ts")!;
    expect(a.directDependents).toBe(1);
    expect(a.transitiveDependents).toBe(0); // the cycle folds back into visited
  });
});

describe("analyzeBlastRadius — level and risk classification", () => {
  const fanIn = (n: number): Record<string, string[]> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`dep${i}.ts`, ["hub.ts"]]));

  it("classifies level by direct-dependent count", () => {
    const level = (n: number) =>
      analyzeBlastRadius(fanIn(n), [], n + 1).find((r) => r.filePath === "hub.ts")!.level;
    expect(level(1)).toBe("low"); // 1 direct, no symbols
    expect(level(2)).toBe("medium");
    expect(level(4)).toBe("high");
    expect(level(8)).toBe("critical");
  });

  it("classifies changeRisk from inbound weight and outbound fragility", () => {
    // Pure sink with low fan-in stays safe: riskScore = 1*2 + 0 = 2.
    const safe = analyzeBlastRadius(fanIn(1), [], 2).find((r) => r.filePath === "hub.ts")!;
    expect(safe.changeRisk).toBe("safe");

    // 3 direct dependents: riskScore = 6 → moderate.
    const moderate = analyzeBlastRadius(fanIn(3), [], 4).find((r) => r.filePath === "hub.ts")!;
    expect(moderate.changeRisk).toBe("moderate");

    // 8 direct dependents: riskScore = 16 → dangerous.
    const dangerous = analyzeBlastRadius(fanIn(8), [], 9).find((r) => r.filePath === "hub.ts")!;
    expect(dangerous.changeRisk).toBe("dangerous");
  });
});

describe("analyzeBlastRadius — symbol usage", () => {
  it("aggregates external callers per exported symbol", () => {
    const links = [
      link("a.ts", "main", "lib.ts", "helper", 3),
      link("b.ts", "run", "lib.ts", "helper", 7),
      link("b.ts", "run", "lib.ts", "other", 9),
    ];
    const results = analyzeBlastRadius({ "a.ts": ["lib.ts"], "b.ts": ["lib.ts"] }, links, 3);
    const lib = results.find((r) => r.filePath === "lib.ts")!;
    expect(lib.exportedSymbols.map((s) => [s.name, s.usedByCount])).toEqual([
      ["helper", 2],
      ["other", 1],
    ]);
    // level: >=1 exported symbol used externally → at least medium
    expect(lib.level).toBe("medium");
  });

  it("dedupes callers by (file, line) — text-linker + LSP double-report is one site", () => {
    const links = [
      link("a.ts", "main", "lib.ts", "helper", 3),
      { ...link("a.ts", "(reference)", "lib.ts", "helper", 3), resolvedBy: "lsp" as const },
    ];
    const results = analyzeBlastRadius({ "a.ts": ["lib.ts"] }, links, 2);
    const lib = results.find((r) => r.filePath === "lib.ts")!;
    expect(lib.exportedSymbols[0]!.usedByCount).toBe(1);
  });

  it("ignores same-file symbol links", () => {
    const links = [link("lib.ts", "caller", "lib.ts", "helper")];
    const results = analyzeBlastRadius({ "a.ts": ["lib.ts"] }, links, 2);
    const lib = results.find((r) => r.filePath === "lib.ts")!;
    expect(lib.exportedSymbols).toHaveLength(0);
  });
});

describe("analyzeBlastRadius — context burden", () => {
  // a → b → c → d, and x → b   (two-hop neighbourhood of b: a, x, c upstream/downstream, d at hop 2 via c)
  const graph = { "a.ts": ["b.ts"], "x.ts": ["b.ts"], "b.ts": ["c.ts"], "c.ts": ["d.ts"] };

  it("counts files within two hops in both directions, excluding the file itself", () => {
    const results = analyzeBlastRadius(graph, [], 5);
    const b = results.find((r) => r.filePath === "b.ts")!;
    // hop 1: a, x (importers), c (import); hop 2: d (via c). Nothing else.
    expect(b.contextBurden).toEqual({ files: 4, lines: null, estimatedTokens: null });
    const d = results.find((r) => r.filePath === "d.ts")!;
    // hop 1: c; hop 2: b
    expect(d.contextBurden?.files).toBe(2);
  });

  it("sizes the neighbourhood from line counts, including the file itself", () => {
    const lineCounts = new Map([["a.ts", 100], ["x.ts", 50], ["b.ts", 10], ["c.ts", 200], ["d.ts", 1000]]);
    const results = analyzeBlastRadius(graph, [], 5, { lineCounts });
    const b = results.find((r) => r.filePath === "b.ts")!;
    expect(b.contextBurden?.lines).toBe(100 + 50 + 10 + 200 + 1000);
    expect(b.contextBurden?.estimatedTokens).toBe(13600);
  });

  it("sums only the files whose size is known", () => {
    const results = analyzeBlastRadius(graph, [], 5, { lineCounts: new Map([["b.ts", 10]]) });
    const a = results.find((r) => r.filePath === "a.ts")!;
    expect(a.contextBurden?.lines).toBe(10); // own size unknown, b known
  });
});
