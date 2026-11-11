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

describe("clarifydoc_trace walk through a shared component's emit", () => {
  // Two pages render the confirm dialog, each binding its own handler to its confirm.
  const DIALOG: SymbolLink[] = [
    link("src/ClubPage.tsx", "ClubPage", 7, "ConfirmDialog", "src/ConfirmDialog.tsx", "ConfirmDialog", 5),
    link("src/PlayerPage.tsx", "PlayerPage", 8, "ConfirmDialog", "src/ConfirmDialog.tsx", "ConfirmDialog", 5),
    { ...link("src/ConfirmDialog.tsx", "ConfirmDialog", 9, "onConfirm", "src/ClubPage.tsx", "saveClub", 4, "dispatch"), viaUsage: [{ file: "src/ClubPage.tsx", line: 7 }] },
    { ...link("src/ConfirmDialog.tsx", "ConfirmDialog", 9, "onConfirm", "src/PlayerPage.tsx", "deletePlayer", 5, "dispatch"), viaUsage: [{ file: "src/PlayerPage.tsx", line: 8 }] },
  ];

  it("follows the emit from a page only back to that page's handler", async () => {
    const text = (await walk(DIALOG, "ClubPage", undefined, "callees", 3, 20)).join("\n");
    expect(text).toContain("saveClub()");
    expect(text).not.toContain("deletePlayer");
  });

  it("walks back from a handler only to the page binding it", async () => {
    const text = (await walk(DIALOG, "deletePlayer", undefined, "callers", 3, 20)).join("\n");
    expect(text).toContain("PlayerPage()");
    expect(text).not.toContain("ClubPage");
  });

  it("follows every binding from the dialog itself", async () => {
    const text = (await walk(DIALOG, "ConfirmDialog", "src/ConfirmDialog.tsx", "callees", 1, 20)).join("\n");
    expect(text).toContain("saveClub()");
    expect(text).toContain("deletePlayer()");
  });
});

describe("clarifydoc_trace to= through a shared component's emit", () => {
  // Two pages call into the confirm dialog, each binding its own handler to its confirm.
  const DIALOG: SymbolLink[] = [
    link("src/ClubPage.tsx", "quickSave", 7, "dialog.onConfirm", "src/ConfirmDialog.tsx", "onConfirm", 5),
    link("src/PlayerPage.tsx", "quickRelease", 8, "dialog.onConfirm", "src/ConfirmDialog.tsx", "onConfirm", 5),
    { ...link("src/ConfirmDialog.tsx", "onConfirm", 6, "emit:confirm", "src/ClubPage.tsx", "saveClub", 4, "dispatch"), viaUsage: [{ file: "src/ClubPage.tsx", line: 3 }] },
    { ...link("src/ConfirmDialog.tsx", "onConfirm", 6, "emit:confirm", "src/PlayerPage.tsx", "deletePlayer", 5, "dispatch"), viaUsage: [{ file: "src/PlayerPage.tsx", line: 3 }] },
  ];

  it("finds the path from a page through the dialog to its own handler", async () => {
    const { pathReport } = await import("./code.js");
    const text = await pathReport(DIALOG, { symbol: "quickSave" }, { symbol: "saveClub" }, 10, "AMBIGUOUS");
    expect(text).toContain("1 shortest path of 2 hops");
    expect(text).toContain("saveClub()");
  });

  it("finds no path from a page through the dialog to another page's handler", async () => {
    const { pathReport } = await import("./code.js");
    const text = await pathReport(DIALOG, { symbol: "quickSave" }, { symbol: "deletePlayer" }, 10, "AMBIGUOUS");
    expect(text).toContain("No call path between them");
  });

  it("finds the path from the dialog itself to every page's handler", async () => {
    const { pathReport } = await import("./code.js");
    expect(await pathReport(DIALOG, { symbol: "onConfirm" }, { symbol: "deletePlayer" }, 10, "AMBIGUOUS")).toContain("1 shortest path of 1 hop");
  });
});

describe("clarifydoc_trace to= that fails", () => {
  const GRAPH: SymbolLink[] = [
    link("src/league.ts", "runSeason", 4, "playMatch", "src/match.ts", "playMatch", 2),
    link("src/match.ts", "playMatch", 5, "extraTime", "src/match.ts", "extraTime", 20),
    link("src/transfer.ts", "signPlayer", 3, "payFee", "src/transfer.ts", "payFee", 9),
  ];

  it("names the node nearest the target, preferring one in the target's file, and what did not resolve there", async () => {
    const { pathReport } = await import("./code.js");
    const asked: string[] = [];
    const text = await pathReport(GRAPH, { symbol: "runSeason" }, { symbol: "payFee" }, 10, "AMBIGUOUS", async (f, s) => {
      asked.push(`${f}::${s}`);
      return { unresolved: 2, total: 5 };
    });
    expect(text).toContain("No call path between them within 8 hops");
    expect(text).toContain("reached 3 functions");
    expect(text).toContain("extraTime() (src/match.ts), 2 hops in");
    expect(text).toContain("extraTime() has 2 of 5 calls not resolved — the path may continue through one of them.");
    expect(asked).toEqual(["src/match.ts::extraTime"]);
  });

  it("prefers a reached node in the target's own file", async () => {
    const { pathReport } = await import("./code.js");
    const links = [...GRAPH, link("src/match.ts", "extraTime", 22, "penalties", "src/transfer.ts", "bookKeeping", 1), link("src/transfer.ts", "audit", 2, "payFee", "src/transfer.ts", "payFee", 9)];
    const text = await pathReport(links, { symbol: "runSeason" }, { symbol: "payFee" }, 10, "AMBIGUOUS");
    expect(text).toContain("bookKeeping() (src/transfer.ts), 3 hops in");
    expect(text).toContain("(in its file)");
  });

  it("says the graph ends where every call resolved", async () => {
    const { pathReport } = await import("./code.js");
    const text = await pathReport(GRAPH, { symbol: "runSeason" }, { symbol: "payFee" }, 10, "AMBIGUOUS", async () => ({ unresolved: 0, total: 3 }));
    expect(text).toContain("resolves all 3 calls it makes: the graph ends there.");
  });
});
