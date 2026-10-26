import { describe, it, expect } from "vitest";
import { computeHealthScore, cycleChain, dimensionPoints, findCircularDeps, HEALTH_MODEL } from "./health-scorer.js";
import type {
  DuplicateGroup, FileComplexityInfo, LayerViolation, PatternInfo,
} from "../types/analysis.js";

const pattern = (kind: string, filePath: string): PatternInfo =>
  ({ kind, filePath, line: 1, message: "" } as unknown as PatternInfo);
const dupe = (filePath: string): DuplicateGroup =>
  ({ occurrences: [{ filePath, line: 1, similarity: 1 }] } as unknown as DuplicateGroup);
const cmplx = (filePath: string, avg: number): FileComplexityInfo =>
  ({ filePath, totalComplexity: avg, maxComplexity: avg, averageComplexity: avg, functions: [] } as unknown as FileComplexityInfo);

const base = {
  analyses: [],
  securityIssues: [],
  layerViolations: [] as LayerViolation[],
};

describe("computeHealthScore — generated-code exclusion", () => {
  it("does not penalize problems that live only in generated barrel trees", () => {
    const input = {
      ...base,
      componentGraph: {
        // 12 app files import the generated barrel → would be "highly coupled".
        ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`app/c${i}.ts`, ["web/src/gen/club/index.ts"]])),
        "web/src/gen/club/index.ts": ["web/src/gen/club/a.ts", "web/src/gen/club/b.ts"],
      },
      patterns: [
        pattern("god-object", "web/src/gen/club/client.ts"),
        pattern("long-file", "web/src/gen/club/schemas.ts"),
      ],
      duplicates: [dupe("web/src/gen/club/a.ts")],
      complexity: [cmplx("web/src/gen/club/a.ts", 50)],
    };

    const withGen = computeHealthScore({ ...input, generatedRoots: ["web/src/gen/club"] });
    const withoutGen = computeHealthScore({ ...input, generatedRoots: [] });

    expect(withGen.score).toBe(100); // all problems were in generated code
    expect(withGen.penalties).toHaveLength(0);
    expect(withoutGen.score).toBeLessThan(100); // same input, no exclusion → penalized
  });

  it("still penalizes problems in authored code", () => {
    const r = computeHealthScore({
      ...base,
      componentGraph: {},
      patterns: [pattern("god-object", "src/App.tsx")],
      duplicates: [],
      complexity: [],
      generatedRoots: ["web/src/gen"],
    });
    expect(r.penalties.some((p) => p.reason.includes("god object"))).toBe(true);
  });

  it("excludes security issues in generated and minified files (pit-stop FP)", () => {
    const sec = (filePath: string, severity: string) =>
      ({ filePath, severity, category: "xss", message: "", line: 1 }) as never;
    const r = computeHealthScore({
      analyses: [{ filePath: "public/js/app.js", minified: true }] as never,
      componentGraph: {},
      patterns: [],
      duplicates: [],
      complexity: [],
      layerViolations: [],
      generatedRoots: ["public/js/plugins"],
      securityIssues: [
        sec("public/js/plugins/ckeditor/ckeditor.js", "high"), // vendored
        sec("public/js/app.js", "high"), // minified bundle
        sec("public/js/plugins/x/y.js", "medium"),
      ],
    });
    expect(r.score).toBe(100);
    expect(r.penalties).toHaveLength(0);
  });
});

describe("computeHealthScore — rates-v2", () => {
  const files = (n: number, dir = "src") => Array.from({ length: n }, (_, i) => ({ filePath: `${dir}/f${i}.ts`, language: "typescript" })) as never;
  const score = (n: number, god: number, extra: Partial<Parameters<typeof computeHealthScore>[0]> = {}) =>
    computeHealthScore({
      ...base,
      analyses: files(n),
      componentGraph: {},
      patterns: Array.from({ length: god }, (_, i) => ({ ...pattern("god-object", `src/f${i}.ts`), confidence: "high" }) as PatternInfo),
      duplicates: [],
      complexity: [],
      ...extra,
    });

  it("deducts half a dimension's cap at its rHalf, and never more than the cap", () => {
    for (const [id, { cap, rHalf }] of Object.entries(HEALTH_MODEL.dimensions)) {
      expect(dimensionPoints(id as never, rHalf)).toBeCloseTo(cap / 2);
      expect(dimensionPoints(id as never, 1)).toBeLessThan(cap);
      expect(dimensionPoints(id as never, 0)).toBe(0);
    }
  });

  it("grades a density, not a count: the same share of god objects costs the same at any size", () => {
    const small = score(200, 10).dimensions!.find((d) => d.id === "godObjects")!;
    const large = score(2000, 100).dimensions!.find((d) => d.id === "godObjects")!;
    expect(small.rate).toBe(large.rate);
    expect(small.points).toBe(large.points);
  });

  it("only ever loses points as a problem grows", () => {
    let last = 101;
    for (const god of [0, 1, 5, 20, 80, 200]) {
      const s = score(400, god).score;
      expect(s).toBeLessThanOrEqual(last);
      last = s;
    }
  });

  it("rates over at least 50 files, so a tiny repo is not failed by one finding", () => {
    expect(score(3, 1).basis).toBe(HEALTH_MODEL.minBasis);
    expect(score(3, 1).score).toBeGreaterThanOrEqual(90);
  });

  it("leaves test code out of every dimension", () => {
    const graph = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`test/c${i}.spec.ts`, ["src/f0.ts"]]));
    const r = score(100, 0, {
      componentGraph: graph,
      patterns: [{ ...pattern("god-object", "test/fixtures.ts"), confidence: "high" } as PatternInfo],
      isTest: (f) => f.startsWith("test/"),
    });
    expect(r.score).toBe(100);
  });

  it("counts a file's repeated security finding once, and layer violations per offending file", () => {
    const sec = (line: number) => ({ filePath: "src/f1.ts", severity: "high", category: "xss", message: "", line }) as never;
    const r = score(100, 0, {
      securityIssues: [sec(1), sec(2), sec(3)],
      layerViolations: [
        { sourceFile: "src/f2.ts", targetFile: "src/f3.ts" },
        { sourceFile: "src/f2.ts", targetFile: "src/f4.ts" },
      ] as LayerViolation[],
    });
    const dim = (id: string) => r.dimensions!.find((d) => d.id === id)!;
    expect(dim("security").count).toBe(1);
    expect(dim("layers").count).toBe(1);
  });

  it("keeps the reason keywords the Health tab routes on", () => {
    const r = computeHealthScore({
      ...base,
      analyses: files(50),
      componentGraph: { "src/f0.ts": ["src/f1.ts"], "src/f1.ts": ["src/f0.ts"] },
      patterns: [
        { ...pattern("god-object", "src/f2.ts"), confidence: "high" } as PatternInfo,
        pattern("long-file", "src/f3.ts"),
        pattern("long-file", "src/f4.ts"),
      ],
      securityIssues: [
        { filePath: "src/f5.ts", severity: "critical", category: "sql-injection", message: "", line: 1 },
        { filePath: "src/f6.ts", severity: "medium", category: "xss", message: "", line: 1 },
      ] as never,
      duplicates: [dupe("src/f7.ts"), dupe("src/f8.ts"), dupe("src/f9.ts")],
      complexity: [cmplx("src/f10.ts", 30)],
      layerViolations: [{ sourceFile: "src/f11.ts", targetFile: "src/f12.ts" }] as LayerViolation[],
    });
    const reasons = r.penalties.map((p) => p.reason).join(" | ");
    for (const kw of ["circular", "god object", "long file", "critical/high security", "medium security", "duplicate", "layer violation", "complexity"]) {
      expect(reasons).toContain(kw);
    }
    expect(r.model).toBe("rates-v2");
    expect(r.score).toBe(100 - r.penalties.reduce((n, p) => n + p.points, 0));
  });
});


describe("cycleChain", () => {
  it("prints a path the imports take, not the group's members in stack order", () => {
    // club → squad → player → club, and player → kit → squad: one group of four.
    const graph = {
      "club.ts": ["squad.ts"],
      "squad.ts": ["player.ts"],
      "player.ts": ["club.ts", "kit.ts"],
      "kit.ts": ["squad.ts"],
    };
    const [group] = findCircularDeps(graph);
    expect(group).toHaveLength(4);
    const chain = cycleChain(graph, group!);
    expect(chain).toEqual(["club.ts", "squad.ts", "player.ts"]);
    // Every step, and the closing one, is a real edge.
    for (let i = 0; i < chain.length; i++) {
      expect(graph[chain[i]! as keyof typeof graph]).toContain(chain[(i + 1) % chain.length]);
    }
  });

  it("finds the shortest way back to the first member", () => {
    const graph = { "a.ts": ["b.ts", "c.ts"], "b.ts": ["c.ts"], "c.ts": ["a.ts"] };
    expect(cycleChain(graph, ["c.ts", "b.ts", "a.ts"])).toEqual(["a.ts", "c.ts"]);
  });

  it("counts the cycles a caller computed once instead of recomputing them", () => {
    const r = computeHealthScore({
      ...base,
      analyses: Array.from({ length: 50 }, (_, i) => ({ filePath: `src/f${i}.ts`, language: "typescript" })) as never,
      componentGraph: {},
      patterns: [],
      duplicates: [],
      complexity: [],
      cycles: [["src/f0.ts", "src/f1.ts"]],
    });
    expect(r.penalties.map((p) => p.reason).join(" ")).toContain("1 circular dependency cycle(s) across 2 file(s)");
  });
});
