import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Build-hazard guards for the split client-JS bundle. Each fragment is authored
// as a template-literal string, so a single stray backtick (even in a comment)
// would terminate the literal and break the tsup build, and any `${` outside the
// one sanctioned interpolation would silently interpolate `undefined`. tsc and
// the byte-diff can't catch these on their own, so we assert the invariants here.

const clientDir = dirname(fileURLToPath(import.meta.url));
const fragmentFiles = readdirSync(clientDir).filter(
  (f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts"),
);
const read = (f: string) => readFileSync(join(clientDir, f), "utf-8");

describe("html-report client fragments — build-hazard guards", () => {
  it("has the expected 13 fragment files", () => {
    expect(fragmentFiles.sort()).toEqual(
      [
        "arch-c4.ts",
        "arch-data-access.ts",
        "arch-graph.ts",
        "arch-types.ts",
        "data-model.ts",
        "filters.ts",
        "health-blast.ts",
        "report-tabs.ts",
        "routes-summary.ts",
        "runtime.ts",
        "screens.ts",
        "traces.ts",
        "ui.ts",
      ].sort(),
    );
  });

  for (const file of fragmentFiles) {
    it(`${file}: exactly two backticks (no stray backtick in the string body)`, () => {
      const backticks = (read(file).match(/`/g) || []).length;
      expect(backticks).toBe(2);
    });
  }

  for (const file of fragmentFiles.filter((f) => f !== "arch-c4.ts")) {
    it(`${file}: no \${ interpolation`, () => {
      expect(read(file).includes("${")).toBe(false);
    });
  }

  it("arch-c4.ts is the sole interpolating fragment and imports UNKNOWN_TARGET", () => {
    const src = read("arch-c4.ts");
    expect(src).toContain('import { UNKNOWN_TARGET } from "../../data-access-graph.js"');
    expect(src).toContain("${JSON.stringify(UNKNOWN_TARGET)}");
  });
});
