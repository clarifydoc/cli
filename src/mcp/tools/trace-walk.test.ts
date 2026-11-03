import { describe, it, expect } from "vitest";
import { walk } from "./code.js";
import type { SymbolLink, SymbolLinkRelation } from "../../types/analysis.js";

const link = (
  sourceFile: string, sourceSymbol: string, sourceLine: number, callName: string,
  targetFile: string, targetSymbol: string, targetLine: number, relation?: SymbolLinkRelation,
): SymbolLink => ({ sourceFile, sourceSymbol, sourceLine, callName, targetFile, targetSymbol, targetLine, confidence: "EXTRACTED", ...(relation ? { relation } : {}) });

/**
 * A season runs matches and publishes the table; a match scores goals (which
 * calls itself), extra time and penalties call each other, two files import
 * `playMatch`, a client reaches a route over HTTP.
 */
const LINKS: SymbolLink[] = [
  link("src/league.ts", "runSeason", 4, "playMatch", "src/match.ts", "playMatch", 2),
  link("src/league.ts", "runSeason", 5, "publishTable", "src/table.ts", "publishTable", 1),
  link("src/league.ts", "runSeason", 3, "new Club", "src/club.ts", "Club", 1, "instantiates"),
  link("src/match.ts", "playMatch", 3, "scoreGoal", "src/match.ts", "scoreGoal", 10),
  link("src/match.ts", "scoreGoal", 12, "scoreGoal", "src/match.ts", "scoreGoal", 10),
  link("src/match.ts", "playMatch", 5, "extraTime", "src/match.ts", "extraTime", 20),
  link("src/match.ts", "extraTime", 21, "penalties", "src/match.ts", "penalties", 30),
  link("src/match.ts", "penalties", 31, "extraTime", "src/match.ts", "extraTime", 20),
  link("src/squad.ts", "(reference)", 1, "playMatch", "src/match.ts", "playMatch", 2, "reference"),
  link("src/squad.ts", "(reference)", 3, "playMatch", "src/match.ts", "playMatch", 2, "reference"),
  link("src/cup.ts", "(reference)", 2, "playMatch", "src/match.ts", "playMatch", 2, "reference"),
  link("src/client.ts", "fetchTable", 7, "GET /api/table", "src/routes.ts", "route:GET /api/table", 9, "http"),
];

describe("clarifydoc_trace walk", () => {
  it("callees of a function never include its callers' callees", async () => {
    const text = (await walk(LINKS, "playMatch", undefined, "callees", 2, 20)).join("\n");
    expect(text).toContain("seed: playMatch() (src/match.ts)");
    expect(text).toContain("scoreGoal() src/match.ts:10 — called from scoreGoal");
    expect(text).not.toContain("runSeason");
    expect(text).not.toContain("publishTable");
    expect(text).not.toContain("Club");
    expect(text).not.toContain("(reference)");
  });

  it("folds import references into one line per importing file, never callers named (reference)", async () => {
    const text = (await walk(LINKS, "playMatch", undefined, "callers", 1, 20)).join("\n");
    expect(text).toContain("runSeason() src/league.ts:4 — calls playMatch");
    expect(text).toContain("- imported by src/cup.ts:2\n");
    expect(text).toContain("- imported by src/squad.ts:1 (+1 more)");
    expect(text).not.toContain("(reference)");
    expect(text).toMatch(/hop 1 \(1\):/);
  });

  it("names what each edge does", async () => {
    expect((await walk(LINKS, "Club", undefined, "callers", 1, 20)).join("\n")).toContain("runSeason() src/league.ts:3 — instantiates new Club");
    expect((await walk(LINKS, "runSeason", undefined, "callees", 1, 20)).join("\n")).toContain("Club() src/club.ts:1 — instantiated from new Club");
    expect((await walk(LINKS, "route:GET /api/table", undefined, "callers", 1, 20)).join("\n")).toContain("fetchTable() src/client.ts:7 — http → GET /api/table");
    expect((await walk(LINKS, "fetchTable", undefined, "callees", 1, 20)).join("\n")).toContain("route:GET /api/table() src/routes.ts:9 — reached over http from GET /api/table");
  });

  it("flags recursion: a function calling itself, and a cycle", async () => {
    const text = (await walk(LINKS, "playMatch", undefined, "callees", 1, 20)).join("\n");
    expect(text).toContain("scoreGoal() src/match.ts:10 — called from scoreGoal [recursive: calls itself]");
    expect(text).toContain("extraTime() src/match.ts:20 — called from extraTime [recursive: in a cycle of 2 functions]");
    expect(text).not.toMatch(/seed: playMatch\(\).*recursive/);
    const cycle = (await walk(LINKS, "penalties", undefined, "callees", 1, 20)).join("\n");
    expect(cycle).toContain("seed: penalties() (src/match.ts) [recursive: in a cycle of 2 functions]");
  });

  it("says how many of a callee's call sites resolved to nothing", async () => {
    const counts: Record<string, { unresolved: number; total: number }> = {
      "src/match.ts::playMatch": { unresolved: 2, total: 4 },
      "src/match.ts::scoreGoal": { unresolved: 0, total: 1 },
    };
    const asked: string[] = [];
    const text = (await walk(LINKS, "playMatch", undefined, "callees", 1, 20, async (f, s) => {
      asked.push(`${f}::${s}`);
      return counts[`${f}::${s}`];
    })).join("\n");
    expect(text).toContain("seed: playMatch() (src/match.ts) · 2 of 4 calls not resolved");
    expect(text).toMatch(/scoreGoal\(\) src\/match\.ts:10 — called from scoreGoal \[recursive: calls itself\]$/m);
    // Asked with the names as written, not the lower-cased keys.
    expect(asked).toContain("src/match.ts::playMatch");
    // Callers never ask.
    asked.length = 0;
    await walk(LINKS, "playMatch", undefined, "callers", 1, 20, async (f, s) => {
      asked.push(`${f}::${s}`);
      return { unresolved: 1, total: 1 };
    });
    expect(asked).toEqual([]);
  });
});
