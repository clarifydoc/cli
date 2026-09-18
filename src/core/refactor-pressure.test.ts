import { describe, it, expect } from "vitest";
import {
  computeRefactorPressure,
  resolveRefactorPressureConfig,
  DEFAULT_REFACTOR_PRESSURE_CONFIG,
} from "./refactor-pressure.js";
import {
  createEmptyAnalysis,
  type BlastRadiusInfo,
  type FileChurnInfo,
  type FileComplexityInfo,
  type ResponsibilityProfile,
} from "../types/analysis.js";

const file = (path: string, lineCount?: number) => {
  const a = createEmptyAnalysis(path, "typescript");
  if (lineCount !== undefined) a.lineCount = lineCount;
  return a;
};
const cx = (filePath: string, maxCognitive: number, totalCognitive: number, nesting: number): FileComplexityInfo => ({
  filePath,
  totalComplexity: totalCognitive,
  maxComplexity: maxCognitive,
  averageComplexity: 1,
  totalCognitive,
  maxCognitive,
  maxNestingDepth: nesting,
  functions: [],
});
const blast = (filePath: string, directDependents: number, dependsOn: number): BlastRadiusInfo => ({
  filePath,
  directDependents,
  transitiveDependents: 0,
  impactScore: directDependents,
  centrality: 0,
  level: "low",
  affectedFiles: [],
  transitiveFiles: [],
  dependsOn: Array.from({ length: dependsOn }, (_, i) => `dep${i}.ts`),
  exportedSymbols: [],
  changeRisk: "safe",
  maxDepth: 1,
});
const churn = (file: string, commits: number, authorCount: number): FileChurnInfo => ({
  file, commits, additions: 0, deletions: 0, lastTouched: "2026-01-01T00:00:00Z", authors: [], authorCount,
});
const profile = (filePath: string, concernCount: number): ResponsibilityProfile => ({
  filePath,
  boundaries: [],
  roles: ["persistence", "transport", "messaging", "security"].slice(0, concernCount) as ResponsibilityProfile["roles"],
  concernCount,
  externalPackageCount: concernCount,
  readsState: true, writesState: false, emitsEvents: false, consumesEvents: false, servesRequests: false, callsExternal: false,
  evidenceCount: 0,
  evidence: [],
});

const base = { componentGraph: {}, layerViolations: [], blastRadius: [], complexity: [] };

describe("computeRefactorPressure", () => {
  it("omits files below the observe band", () => {
    const rows = computeRefactorPressure({ ...base, analyses: [file("calm.ts", 40)], complexity: [cx("calm.ts", 2, 4, 1)] });
    expect(rows).toEqual([]);
  });

  it("scores a file that is moderately bad on every axis above one that is extreme on a single axis", () => {
    const analyses = [file("everywhere.ts", 500), file("onlybig.ts", 3000)];
    const rows = computeRefactorPressure({
      ...base,
      analyses,
      complexity: [cx("everywhere.ts", 30, 120, 3), cx("onlybig.ts", 2, 10, 1)],
      blastRadius: [blast("everywhere.ts", 9, 9), blast("onlybig.ts", 0, 0)],
      responsibilityProfiles: [profile("everywhere.ts", 3)],
      fileChurn: [churn("everywhere.ts", 18, 3)],
    });
    // Size alone is weighted lightly: 3000 simple lines never reach "observe".
    expect(rows.map((r) => r.filePath)).toEqual(["everywhere.ts"]);
    const [e] = rows;
    expect(e.drivers).toEqual(
      expect.arrayContaining(["high_cognitive_complexity", "deep_nesting", "mixed_concerns", "many_dependents", "many_dependencies", "high_churn", "many_authors"]),
    );
    expect(e.confidence).toBe(1);
  });

  it("marks churn unavailable, lowers confidence and rescales when there is no git history", () => {
    const [row] = computeRefactorPressure({
      ...base,
      analyses: [file("hot.ts", 900)],
      complexity: [cx("hot.ts", 60, 250, 6)],
      // fileChurn intentionally absent
    });
    expect(row.components.churn).toBeNull();
    expect(row.evidence.commits).toBeNull();
    // 1 - churn weight
    expect(row.confidence).toBe(0.75);
    // complexity and size saturate (100 each); responsibility and coupling are
    // genuine zeros → (0.25·100 + 0.1·100) / 0.75
    expect(row.score).toBeCloseTo(46.7, 1);
    expect(row.band).toBe("suggest");
  });

  it("fires hard gates and lifts the band even when the weighted score is low", () => {
    const rows = computeRefactorPressure({
      ...base,
      analyses: [file("hub.ts", 60)],
      complexity: [cx("hub.ts", 1, 2, 0)],
      blastRadius: [blast("hub.ts", 12, 11)],
      responsibilityProfiles: [profile("hub.ts", 4)],
    });
    const [hub] = rows;
    expect(hub.gates).toEqual(["concern_overload", "dependency_hub"]);
    expect(hub.band).toBe("strong"); // two gates → at least strong
  });

  it("recognizes a god class from size plus total cognitive load", () => {
    const [g] = computeRefactorPressure({ ...base, analyses: [file("god.ts", 700)], complexity: [cx("god.ts", 12, 150, 2)] });
    expect(g.gates).toContain("god_class");
    expect(g.drivers).toContain("large_file");
  });

  it("fires the churn hotspot gate only for the top percentile that is also complex", () => {
    const analyses = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((n) => file(`${n}.ts`, 100));
    const complexity = analyses.map((a) => cx(a.filePath, 40, 100, 4));
    const fileChurn = analyses.map((a, i) => churn(a.filePath, i === 9 ? 40 : 3, 1));
    const rows = computeRefactorPressure({ ...base, analyses, complexity, fileChurn });
    const gated = rows.filter((r) => r.gates.includes("churn_hotspot")).map((r) => r.filePath);
    expect(gated).toEqual(["j.ts"]);
  });

  it("excludes files the caller rules out and counts cycle membership as coupling", () => {
    const analyses = [file("a.ts", 100), file("b.ts", 100), file("a.test.ts", 100)];
    const rows = computeRefactorPressure({
      ...base,
      analyses,
      componentGraph: { "a.ts": ["b.ts"], "b.ts": ["a.ts"], "a.test.ts": ["a.ts"] },
      complexity: analyses.map((a) => cx(a.filePath, 40, 120, 4)),
      exclude: (f) => f.endsWith(".test.ts"),
    });
    expect(rows.map((r) => r.filePath).sort()).toEqual(["a.ts", "b.ts"]);
    expect(rows.every((r) => r.evidence.inCycle && r.drivers.includes("dependency_cycle"))).toBe(true);
  });

  it("falls back to function spans and cyclomatic numbers for artifacts from older extractors", () => {
    const a = file("old.ts");
    a.functions.push({ name: "f", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line: 1, endLine: 640 });
    const legacyCx: FileComplexityInfo = { filePath: "old.ts", totalComplexity: 140, maxComplexity: 28, averageComplexity: 10, functions: [] };
    const [row] = computeRefactorPressure({ ...base, analyses: [a], complexity: [legacyCx] });
    expect(row.evidence.loc).toBe(640);
    expect(row.evidence.maxCognitive).toBeNull();
    expect(row.drivers).toContain("high_cyclomatic_complexity");
  });
});

describe("resolveRefactorPressureConfig", () => {
  it("returns the defaults untouched for no input", () => {
    expect(resolveRefactorPressureConfig(undefined)).toBe(DEFAULT_REFACTOR_PRESSURE_CONFIG);
  });

  it("overlays valid numbers and keeps defaults for bad ones, warning once each", () => {
    const warnings: string[] = [];
    const cfg = resolveRefactorPressureConfig(
      { ceilings: { loc: 1200, nope: 3 } as never, weights: { churn: -1 }, bands: { urgent: 90 } },
      (w) => warnings.push(w),
    );
    expect(cfg.ceilings.loc).toBe(1200);
    expect(cfg.ceilings.maxCognitive).toBe(DEFAULT_REFACTOR_PRESSURE_CONFIG.ceilings.maxCognitive);
    expect(cfg.weights.churn).toBe(DEFAULT_REFACTOR_PRESSURE_CONFIG.weights.churn);
    expect(cfg.bands.urgent).toBe(90);
    expect(warnings).toHaveLength(2);
    expect(warnings).toEqual(expect.arrayContaining([expect.stringMatching(/unknown key "nope"/), expect.stringMatching(/weights\.churn/)]));
  });

  it("rejects bands that are not non-decreasing", () => {
    const warnings: string[] = [];
    const cfg = resolveRefactorPressureConfig({ bands: { observe: 80 } }, (w) => warnings.push(w));
    expect(cfg.bands).toEqual(DEFAULT_REFACTOR_PRESSURE_CONFIG.bands);
    expect(warnings[0]).toMatch(/non-decreasing/);
  });
});
