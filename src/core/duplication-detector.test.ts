import { describe, it, expect } from "vitest";
import { detectDuplicates } from "./duplication-detector.js";
import type { FileAnalysis } from "../types/analysis.js";

const fn = (
  name: string,
  calls: string[],
  opts: { line?: number; span?: number; params?: number } = {},
) => ({
  name,
  line: opts.line ?? 10,
  endLine: (opts.line ?? 10) + (opts.span ?? 10),
  params: Array.from({ length: opts.params ?? 1 }, (_, i) => ({ name: `p${i}` })),
  calls: calls.map((c) => ({ name: c, kind: "same-file" })),
  decorators: [] as string[],
});

const file = (filePath: string, functions: ReturnType<typeof fn>[]): FileAnalysis =>
  ({ filePath, language: "typescript", functions } as unknown as FileAnalysis);

describe("detectDuplicates — name-based precision", () => {
  it("does not group functions that merely share a name (different calls)", () => {
    // Real-repo FP shape: `submit` in many Vue components, each calling different services
    const groups = detectDuplicates([
      file("a/CreateLicense.ts", [fn("submit", ["createLicense", "toastOk"])]),
      file("b/UpdateLicense.ts", [fn("submit", ["updateLicense", "closeModal"])]),
      file("c/CreateOrg.ts", [fn("submit", ["createOrganisation", "navigate"])]),
    ]);
    expect(groups.filter((g) => g.kind === "name-based")).toHaveLength(0);
  });

  it("groups same-name functions whose calls genuinely overlap", () => {
    const calls = ["parseISO", "format", "padStart"];
    const groups = detectDuplicates([
      file("a/x.ts", [fn("formatStamp", calls)]),
      file("b/y.ts", [fn("formatStamp", calls)]),
      file("c/z.ts", [fn("formatStamp", calls)]),
    ]);
    const g = groups.find((x) => x.functionName === "formatStamp");
    expect(g).toBeDefined();
    expect(g!.occurrences).toHaveLength(3);
  });

  it("drops dissimilar occurrences from a group instead of tagging them along", () => {
    const calls = ["parseISO", "format", "padStart"];
    const groups = detectDuplicates([
      file("a/x.ts", [fn("formatStamp", calls)]),
      file("b/y.ts", [fn("formatStamp", calls)]),
      file("c/z.ts", [fn("formatStamp", calls)]),
      file("d/w.ts", [fn("formatStamp", ["totallyDifferent", "other"])]),
    ]);
    const g = groups.find((x) => x.functionName === "formatStamp");
    expect(g).toBeDefined();
    expect(g!.occurrences.map((o) => o.filePath)).not.toContain("d/w.ts");
  });

  it("ignores tiny idiomatic handlers (short span or <2 calls)", () => {
    const groups = detectDuplicates([
      file("a/x.ts", [fn("onDragStart", ["setData"], { span: 3 })]),
      file("b/y.ts", [fn("onDragStart", ["setData"], { span: 3 })]),
      file("c/z.ts", [fn("onDragStart", ["setData"], { span: 3 })]),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("excludes test files entirely (mock factories repeat by design)", () => {
    const calls = ["createTraining", "withDefaults", "freeze"];
    const groups = detectDuplicates([
      file("a/Training.spec.ts", [fn("createMockTraining", calls)]),
      file("b/PlayerList.spec.ts", [fn("createMockTraining", calls)]),
      file("c/useAssign.spec.ts", [fn("createMockTraining", calls)]),
      file("tests/helpers.ts", [fn("createMockTraining", calls)]),
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe("detectDuplicates — structural", () => {
  it("still finds cross-file structural clones under different names", () => {
    const calls = ["fetchRows", "mapRow", "sortBy", "renderTable"];
    const groups = detectDuplicates([
      file("a/x.ts", [fn("buildUserTable", calls, { span: 12, params: 2 })]),
      file("b/y.ts", [fn("buildOrderTable", calls, { span: 13, params: 2 })]),
    ]);
    expect(groups.some((g) => g.kind === "structural")).toBe(true);
  });
});
