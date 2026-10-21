import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { denormalizeProject } from "./element-registry.js";
import { pressureAction } from "./suggestions-engine.js";
import type { ProjectAnalysis, RefactorPressureInfo } from "../types/analysis.js";

/**
 * The decision layer — score, bands, gates, the wording of the action, and the
 * codec path for `refactorPressure` — had no gate against real extraction
 * output: every unit test built rows by hand, and no fixture produced a single
 * pressure row. `sample-pressure` exists to close that: one module that mixes
 * persistence, transport, messaging and security, deeply nested, imported
 * twice; plus a large but cohesive module with no boundaries as the control.
 */
const REPO_ROOT = resolve(__dirname, "..", "..");
const summary: ProjectAnalysis = denormalizeProject(
  JSON.parse(readFileSync(resolve(REPO_ROOT, "test-output/sample-pressure/project-summary.json"), "utf-8")),
);
const rows = summary.refactorPressure ?? [];
const row = (suffix: string): RefactorPressureInfo =>
  rows.find((r) => r.filePath.endsWith(suffix)) as RefactorPressureInfo;

describe("sample-pressure — refactor pressure reaches the artifact", () => {
  it("scores the mixed-concern module and nothing else", () => {
    expect(rows.map((r) => r.filePath)).toEqual(["src/cars.ts"]);
  });

  it("ranks it strong on evidence, not on one axis", () => {
    const r = row("cars.ts");
    expect(r.band).toBe("strong");
    expect(r.drivers).toEqual(
      expect.arrayContaining(["high_cognitive_complexity", "deep_nesting", "large_file", "mixed_concerns"]),
    );
    expect(r.gates).toContain("concern_overload");
  });

  it("reports the confidence honestly — fixtures carry no git history", () => {
    const r = row("cars.ts");
    expect(r.components.churn).toBeNull();
    expect(r.confidence).toBe(0.75);
  });

  it("carries the evidence a reader needs to check the score", () => {
    const e = row("cars.ts").evidence;
    expect(e.concernCount).toBe(4);
    expect(e.roles).toEqual(expect.arrayContaining(["persistence", "transport", "messaging", "security"]));
    expect(e.maxCognitive).toBeGreaterThan(20);
    expect(e.maxNestingDepth).toBeGreaterThanOrEqual(4);
    expect(e.directDependents).toBe(2);
  });

  it("does not flag the large but cohesive module", () => {
    expect(rows.some((r) => r.filePath.endsWith("report.ts"))).toBe(false);
  });

  it("turns the strong row into a suggestion with a concrete action", () => {
    const s = (summary.suggestions ?? []).filter((x) => x.category === "Refactor pressure");
    expect(s).toHaveLength(1);
    expect(s[0]!.filePath).toBe("src/cars.ts");
    expect(s[0]!.actionable).toMatch(/Split by responsibility/);
    expect(s[0]!.evidence).toContain("mixed_concerns");
    expect(s[0]!.confidence).toBe(0.75);
  });

  it("classifies the database writes the module performs", () => {
    const cars = (summary.responsibilityProfiles ?? []).find((p) => p.filePath.endsWith("cars.ts"))!;
    expect(cars.roles).toEqual(expect.arrayContaining(["persistence", "transport", "messaging", "security"]));
    expect(cars.emitsEvents).toBe(true);
    expect(cars.consumesEvents).toBe(true);
    expect(cars.callsExternal).toBe(true);
  });
});

describe("pressureAction picks the action that fits the drivers", () => {
  const base: RefactorPressureInfo = {
    filePath: "x.ts",
    score: 70,
    band: "strong",
    components: { complexity: 0, size: 0, responsibility: 0, coupling: 0, churn: 0 },
    drivers: [],
    gates: [],
    confidence: 1,
    evidence: {
      loc: 100, functions: 5, maxCyclomatic: 1, totalCyclomatic: 5,
      maxCognitive: 0, totalCognitive: 0, maxNestingDepth: 0,
      concernCount: 0, roles: [], directDependents: 0, transitiveDependents: 0,
      dependsOn: 0, inCycle: false, layerViolations: 0, commits: 0, authors: 0,
    },
  };
  const withRow = (patch: Partial<RefactorPressureInfo>) => pressureAction({ ...base, ...patch });

  const cases: Array<[label: string, patch: Partial<RefactorPressureInfo>, expected: RegExp]> = [
    ["mixed concerns names the roles", { drivers: ["mixed_concerns"], evidence: { ...base.evidence, roles: ["persistence", "transport"] } }, /Split by responsibility.*persistence, transport/],
    ["concern overload gate", { gates: ["concern_overload"], evidence: { ...base.evidence, roles: ["persistence"] } }, /Split by responsibility/],
    ["dependency hub", { gates: ["dependency_hub"] }, /Narrow the public surface/],
    ["hub by drivers", { drivers: ["many_dependents", "many_dependencies"] }, /Narrow the public surface/],
    ["cycle", { drivers: ["dependency_cycle"] }, /Break the import cycle/],
    ["complexity", { drivers: ["high_cognitive_complexity"] }, /Flatten the most nested/],
    ["nesting", { drivers: ["deep_nesting"] }, /Flatten the most nested/],
    ["churn", { drivers: ["high_churn"] }, /Stabilize before the next change/],
    ["god class", { gates: ["god_class"] }, /Break the file up/],
    ["large file", { drivers: ["large_file"] }, /Break the file up/],
    ["nothing specific", {}, /Review the drivers/],
  ];

  for (const [label, patch, expected] of cases) {
    it(label, () => {
      expect(withRow(patch)).toMatch(expected);
    });
  }

  it("prefers the responsibility split over the complexity advice when both apply", () => {
    expect(
      withRow({
        drivers: ["mixed_concerns", "high_cognitive_complexity"],
        evidence: { ...base.evidence, roles: ["persistence", "messaging"] },
      }),
    ).toMatch(/Split by responsibility/);
  });

  it("drops the ubiquitous roles from the advice", () => {
    const action = withRow({
      drivers: ["mixed_concerns"],
      evidence: { ...base.evidence, roles: ["observability", "configuration", "persistence"] },
    });
    expect(action).toContain("persistence");
    expect(action).not.toContain("observability");
  });
});
