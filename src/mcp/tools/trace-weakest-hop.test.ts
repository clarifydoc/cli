import { describe, it, expect } from "vitest";
import { pathReport } from "./code.js";
import type { SymbolLink } from "../../types/analysis.js";

const link = (sf: string, ss: string, line: number, tf: string, ts: string, confidence: SymbolLink["confidence"] = "EXTRACTED", strategy?: SymbolLink["strategy"]): SymbolLink =>
  ({ sourceFile: sf, sourceSymbol: ss, sourceLine: line, callName: ts, targetFile: tf, targetSymbol: ts, targetLine: 1, confidence, ...(strategy ? { strategy } : {}) });

describe("clarifydoc_trace to= — weakest hop", () => {
  it("names the least certain hop by confidence, then by how guessy its strategy is", async () => {
    const links = [
      link("src/league.ts", "runSeason", 4, "src/match.ts", "playMatch", "EXTRACTED", "direct"),
      link("src/match.ts", "playMatch", 8, "src/table.ts", "scoreGoal", "INFERRED", "inheritance"),
      link("src/table.ts", "scoreGoal", 12, "src/club.ts", "payBonus", "INFERRED", "unique-global"),
    ];
    const text = await pathReport(links, { symbol: "runSeason" }, { symbol: "payBonus" }, 10, "AMBIGUOUS");
    expect(text).toContain("Weakest hop of the surest path: scoreGoal() → payBonus() at src/table.ts:12 — inferred via unique-global");
    expect(text).not.toContain("Search stopped");
  });

  it("an ambiguous hop outranks an inferred one", async () => {
    const links = [
      link("src/a.ts", "kickOff", 1, "src/b.ts", "pass", "AMBIGUOUS", "unique-global"),
      link("src/b.ts", "pass", 2, "src/c.ts", "shoot", "INFERRED", "unique-global-blind"),
    ];
    const text = await pathReport(links, { symbol: "kickOff" }, { symbol: "shoot" }, 10, "AMBIGUOUS");
    expect(text).toContain("Weakest hop of the surest path: kickOff() → pass() at src/a.ts:1 — ambiguous via unique-global");
  });

  it("says when the search stopped at its path cap", async () => {
    const links: SymbolLink[] = [];
    for (let i = 0; i < 7; i++) {
      links.push(link("src/a.ts", "start", i + 1, `src/m${i}.ts`, `mid${i}`));
      links.push(link(`src/m${i}.ts`, `mid${i}`, 1, "src/z.ts", "goal"));
    }
    const text = await pathReport(links, { symbol: "start" }, { symbol: "goal" }, 10, "AMBIGUOUS");
    expect(text).toContain("Search stopped: the search keeps at most 5 paths of that length per end");
  });

  it("says when the path was found only at the hop limit", async () => {
    const links: SymbolLink[] = [];
    for (let i = 0; i < 8; i++) links.push(link(`src/s${i}.ts`, `step${i}`, 1, `src/s${i + 1}.ts`, `step${i + 1}`));
    const text = await pathReport(links, { symbol: "step0" }, { symbol: "step8" }, 10, "AMBIGUOUS");
    expect(text).toContain("found only at the 8-hop search limit");
  });
});
