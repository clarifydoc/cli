import { describe, it, expect } from "vitest";
import { findDecisionMarkers, governedFiles, insideRoot } from "./context-docs.js";

describe("decision markers", () => {
  it("reads an upper-case tag after a comment leader in any comment syntax", () => {
    const text = [
      "// WHY: the league table is cached because standings change once a match ends",
      "const x = 1; // DECISION: clubs are soft-deleted",
      "# TRADEOFF: one query per match, not per player",
      "-- RATIONALE: the garage view joins cars once",
      " * REJECTED: a second cache layer",
      "<!-- ADR: 0004 -->",
      "const why = 'WHY: in a string, not a comment';",
      "// why: lower case is prose",
    ].join("\n");
    expect(findDecisionMarkers(text, "src/league.ts").map((m) => [m.line, m.tag, m.text])).toEqual([
      [1, "WHY", "the league table is cached because standings change once a match ends"],
      [2, "DECISION", "clubs are soft-deleted"],
      [3, "TRADEOFF", "one query per match, not per player"],
      [4, "RATIONALE", "the garage view joins cars once"],
      [5, "REJECTED", "a second cache layer"],
      [6, "ADR", "0004"],
    ]);
  });
});

describe("decision markers in documentation comments", () => {
  it("reads a Sphinx marker with its continuation lines as one record", () => {
    const text = [
      "#: WHY: keep the old loader because",
      "#: the new one breaks Match.replay",
      "",
      "#: an ordinary attribute doc",
      "LOADER = 1",
    ].join("\n");
    expect(findDecisionMarkers(text, "league.py").map((m) => [m.line, m.tag, m.text])).toEqual([
      [1, "WHY", "keep the old loader because the new one breaks Match.replay"],
    ]);
  });

  it("reads Doxygen markers, and ordinary doc comments with no label give nothing", () => {
    const text = [
      "/// Returns the club's table.",
      "/// WHY: cached per match day",
      "/// to spare the database",
      "int table();",
      "//! DECISION: players are never hard-deleted",
      "//! see the garage notes",
      "//! Plain inner doc.",
      "/// Another doc line.",
    ].join("\n");
    expect(findDecisionMarkers(text, "club.h").map((m) => [m.line, m.tag, m.text])).toEqual([
      [2, "WHY", "cached per match day to spare the database"],
      [5, "DECISION", "players are never hard-deleted see the garage notes Plain inner doc."],
    ]);
    expect(findDecisionMarkers("/// A club.\n//! A player.\n#: A car.", "x.h")).toEqual([]);
  });

  it("does not join a different style or a code line", () => {
    expect(findDecisionMarkers("// WHY: a\n# b\nx = 1\n// c", "a.ts").map((m) => m.text)).toEqual(["a"]);
  });
});

describe("governed files", () => {
  const files = ["src/clubs/service.ts", "src/players/service.ts", "src/league/table.ts", "README.md"];
  it("names a file by its path, a unique suffix or a unique file name", () => {
    const text = "We changed `src/league/table.ts` and players/service.ts; table.ts stays. service.ts is ambiguous.";
    expect(governedFiles(text, files).sort()).toEqual(["src/league/table.ts", "src/players/service.ts"]);
  });
});

describe("inside the root", () => {
  it("keeps a declared path inside the project", () => {
    expect(insideRoot("/p", "docs/ARCH.md")).toBe("docs/ARCH.md");
    expect(insideRoot("/p", "./docs/../GLOSSARY.md")).toBe("GLOSSARY.md");
    for (const bad of ["../secret.md", "/etc/passwd", "docs/../../x.md", ""]) expect(insideRoot("/p", bad)).toBeNull();
  });
});
