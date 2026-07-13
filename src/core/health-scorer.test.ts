import { describe, it, expect } from "vitest";
import { computeHealthScore } from "./health-scorer.js";
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
        ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`app/c${i}.ts`, ["web/src/gen/account/index.ts"]])),
        "web/src/gen/account/index.ts": ["web/src/gen/account/a.ts", "web/src/gen/account/b.ts"],
      },
      patterns: [
        pattern("god-object", "web/src/gen/account/client.ts"),
        pattern("long-file", "web/src/gen/account/schemas.ts"),
      ],
      duplicates: [dupe("web/src/gen/account/a.ts")],
      complexity: [cmplx("web/src/gen/account/a.ts", 50)],
    };

    const withGen = computeHealthScore({ ...input, generatedRoots: ["web/src/gen/account"] });
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

  it("excludes security issues in generated and minified files (spsflow FP)", () => {
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
