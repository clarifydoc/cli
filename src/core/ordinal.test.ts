import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { byOrdinal, byOrdinalKey } from "./ordinal.js";

const REPO_ROOT = resolve(__dirname, "..", "..");

describe("byOrdinal", () => {
  it("orders by code unit, so uppercase precedes lowercase", () => {
    expect(["a.ts", "A.ts", "b.ts", "B.ts"].sort(byOrdinal)).toEqual(["A.ts", "B.ts", "a.ts", "b.ts"]);
  });

  it("agrees with itself whatever the process locale would do", () => {
    // These are exactly the names that reorder between en-US, sv-SE, da-DK and tr-TR.
    const names = ["a.ts", "A.ts", "Ä.ts", "ab.ts", "Ab.ts", "index.ts", "Index.ts", "_x.ts"];
    expect([...names].sort(byOrdinal)).toEqual(
      ["A.ts", "Ab.ts", "Index.ts", "_x.ts", "a.ts", "ab.ts", "index.ts", "Ä.ts"],
    );
  });

  it("returns 0 for equal strings so sorts stay stable", () => {
    expect(byOrdinal("same", "same")).toBe(0);
  });

  it("byOrdinalKey sorts by a derived key", () => {
    const rows = [{ p: "b" }, { p: "A" }, { p: "a" }];
    expect(rows.sort(byOrdinalKey((r) => r.p)).map((r) => r.p)).toEqual(["A", "a", "b"]);
  });
});

describe("no locale-dependent ordering reaches the analysis output", () => {
  // `localeCompare` without a locale follows LANG/LC_ALL, so the same repository
  // sorts differently per machine — and file order seeds every page id in the
  // persisted artifacts. There is no eslint here (lint is `tsc --noEmit`), so
  // this test is the guard.
  const files = globSync(["src/core/**/*.ts", "src/extractors/**/*.ts", "src/mcp/**/*.ts"], {
    cwd: REPO_ROOT,
    ignore: ["**/*.test.ts", "**/viewer-assets/**"],
  });

  it("found source files to check", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("uses byOrdinal instead of localeCompare", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (rel.endsWith("src/core/ordinal.ts")) continue; // documents the hazard
      const text = readFileSync(resolve(REPO_ROOT, rel), "utf-8");
      for (const [i, line] of text.split("\n").entries()) {
        // A bare mention in a string literal (a list of builtin member names)
        // is not a call; only `.localeCompare(` is.
        if (line.includes(".localeCompare(")) offenders.push(`${rel}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
