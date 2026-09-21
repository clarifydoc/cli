import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { denormalizeProject } from "./element-registry.js";
import type { BlastRadiusInfo, ProjectAnalysis } from "../types/analysis.js";

/**
 * The unit tests build `FileRiskInput` by hand, so they prove the decision
 * table and nothing about whether real extraction output ever reaches it.
 * This pins the whole path — analyzer wiring, the element-registry codec, and
 * the classification itself — against a committed artifact.
 *
 * `sample-pressure` is the right corpus for it: one module that mixes
 * persistence, transport, messaging and security (`orders.ts`), one that only
 * serves routes (`routes.ts`), and one leaf (`worker.ts`) — three different
 * categories from four files.
 */
const REPO_ROOT = resolve(__dirname, "..", "..");
const summary: ProjectAnalysis = denormalizeProject(
  JSON.parse(readFileSync(resolve(REPO_ROOT, "test-output/sample-pressure/project-summary.json"), "utf-8")),
);
const rows = summary.blastRadius ?? [];
const row = (suffix: string): BlastRadiusInfo =>
  rows.find((r) => r.filePath.endsWith(suffix)) as BlastRadiusInfo;

describe("sample-pressure — risk verdicts reach the artifact", () => {
  it("gives every blast row a verdict with a non-empty reasons list", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.verdict, r.filePath).toBeDefined();
      expect(r.verdict!.reasons.length, r.filePath).toBeGreaterThan(0);
      expect(r.verdict!.summary.length, r.filePath).toBeGreaterThan(0);
    }
  });

  it("calls the mixed-concern module a boundary, not a foundation", () => {
    // It exports `Order`, `OrderLine` and `Actor`, but it is a module that
    // talks to the DB, an HTTP payment API and a broker. The interface
    // declarations are incidental — see maxConcernsForInterfaceRule.
    const v = row("orders.ts").verdict!;
    expect(v.category).toBe("boundary");
    expect(v.reasons).toEqual(
      expect.arrayContaining(["calls_external_service", "broker_boundary", "datastore_boundary"]),
    );
    expect(v.reasons).not.toContain("exported_interface_in_use");
  });

  it("names the route file a boundary and records the escalation that raised it", () => {
    const v = row("routes.ts").verdict!;
    expect(v.category).toBe("boundary");
    expect(v.reasons).toContain("serves_api_routes");
    // The cross-tier reach raised changeRisk/level in trace-impact.ts; before
    // the verdict existed nothing recorded that it had.
    expect(v.reasons).toContain("cross_tier_escalation");
    expect(row("routes.ts").changeRisk).not.toBe("safe");
  });

  it("calls the leaf localized and says so with less confidence", () => {
    const v = row("worker.ts").verdict!;
    expect(v.category).toBe("localized");
    expect(v.level).toBe("low");
    // No responsibility profile and no cross-tier reach for this file.
    expect(v.confidence).toBeLessThan(1);
  });

  it("never names a source file in behaviourAtRisk — it cannot be page-encoded", () => {
    // Routes may be path-shaped and that is fine; what must not appear is a
    // file from the analysis, which would silently rot when the file moved.
    const known = new Set(summary.files);
    for (const r of rows) {
      for (const b of r.verdict?.behaviourAtRisk ?? []) {
        for (const f of known) {
          expect(b.includes(f), `${r.filePath}: "${b}" names ${f}`).toBe(false);
        }
      }
    }
  });
});
