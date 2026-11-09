import { describe, it, expect } from "vitest";
import { keyOf, usageGate } from "./symbol-graph.js";
import { dedupSymbolLinks } from "./symbol-dedup.js";
import type { SymbolLink } from "../types/analysis.js";

const link = (sourceFile: string, sourceSymbol: string, targetFile: string, targetSymbol: string, viaUsage?: SymbolLink["viaUsage"]): SymbolLink => ({
  sourceFile, sourceSymbol, sourceLine: 3, callName: targetSymbol, targetFile, targetSymbol, targetLine: 1, confidence: "INFERRED", ...(viaUsage ? { viaUsage } : {}),
});

// A shared dialog two pages render, each binding its confirm; a third renders it binding nothing.
const LINKS: SymbolLink[] = [
  link("ClubPage.tsx", "ClubPage", "ConfirmDialog.tsx", "ConfirmDialog"),
  link("PlayerPage.tsx", "PlayerPage", "ConfirmDialog.tsx", "ConfirmDialog"),
  link("MatchPage.tsx", "MatchPage", "ConfirmDialog.tsx", "ConfirmDialog"),
  link("ConfirmDialog.tsx", "ConfirmDialog", "ConfirmDialog.tsx", "handleOk"),
  link("ConfirmDialog.tsx", "handleOk", "ClubPage.tsx", "saveClub", [{ file: "ClubPage.tsx", line: 7 }]),
  link("ConfirmDialog.tsx", "handleOk", "PlayerPage.tsx", "deletePlayer", [{ file: "PlayerPage.tsx", line: 8 }]),
];
const k = (file: string, symbol: string) => keyOf(file, symbol);

describe("usageGate", () => {
  const gate = usageGate(LINKS);

  it("leaves a child only to the page the walk entered it from", () => {
    const inDialog = gate.forward("", k("ClubPage.tsx", "ClubPage"), k("ConfirmDialog.tsx", "ConfirmDialog"))!;
    const inOk = gate.forward(inDialog, k("ConfirmDialog.tsx", "ConfirmDialog"), k("ConfirmDialog.tsx", "handleOk"))!;
    expect(gate.forward(inOk, k("ConfirmDialog.tsx", "handleOk"), k("ClubPage.tsx", "saveClub"))).not.toBeNull();
    expect(gate.forward(inOk, k("ConfirmDialog.tsx", "handleOk"), k("PlayerPage.tsx", "deletePlayer"))).toBeNull();
  });

  it("takes every binding from a walk that starts inside the child, or enters it from a file binding nothing", () => {
    expect(gate.forward("", k("ConfirmDialog.tsx", "handleOk"), k("PlayerPage.tsx", "deletePlayer"))).not.toBeNull();
    const fromMatch = gate.forward("", k("MatchPage.tsx", "MatchPage"), k("ConfirmDialog.tsx", "ConfirmDialog"))!;
    const inOk = gate.forward(fromMatch, k("ConfirmDialog.tsx", "ConfirmDialog"), k("ConfirmDialog.tsx", "handleOk"))!;
    expect(gate.forward(inOk, k("ConfirmDialog.tsx", "handleOk"), k("PlayerPage.tsx", "deletePlayer"))).not.toBeNull();
  });

  it("walks back from a handler only to the page binding it", () => {
    const back = gate.reverse("", k("PlayerPage.tsx", "deletePlayer"), k("ConfirmDialog.tsx", "handleOk"))!;
    const atDialog = gate.reverse(back, k("ConfirmDialog.tsx", "handleOk"), k("ConfirmDialog.tsx", "ConfirmDialog"))!;
    expect(gate.reverse(atDialog, k("ConfirmDialog.tsx", "ConfirmDialog"), k("PlayerPage.tsx", "PlayerPage"))).toBe("");
    expect(gate.reverse(atDialog, k("ConfirmDialog.tsx", "ConfirmDialog"), k("ClubPage.tsx", "ClubPage"))).toBeNull();
    expect(gate.reverse(atDialog, k("ConfirmDialog.tsx", "ConfirmDialog"), k("MatchPage.tsx", "MatchPage"))).toBe("");
  });

  it("is open when no link states a binding, and for an edge one of its links leaves unbound", () => {
    expect(usageGate(LINKS.map(({ viaUsage: _u, ...l }) => l)).active).toBe(false);
    const open = usageGate([...LINKS, link("ConfirmDialog.tsx", "handleOk", "PlayerPage.tsx", "deletePlayer")]);
    const inOk = open.forward(open.forward("", k("ClubPage.tsx", "ClubPage"), k("ConfirmDialog.tsx", "ConfirmDialog"))!, k("ConfirmDialog.tsx", "ConfirmDialog"), k("ConfirmDialog.tsx", "handleOk"))!;
    expect(open.forward(inOk, k("ConfirmDialog.tsx", "handleOk"), k("PlayerPage.tsx", "deletePlayer"))).not.toBeNull();
  });
});

describe("dedupSymbolLinks and binding sites", () => {
  it("keeps the binding sites of both duplicates, and none when one states none", () => {
    const a = link("ConfirmDialog.tsx", "handleOk", "ClubPage.tsx", "saveClub", [{ file: "ClubPage.tsx", line: 7 }]);
    const b = link("ConfirmDialog.tsx", "handleOk", "ClubPage.tsx", "saveClub", [{ file: "ClubPage.tsx", line: 12 }]);
    expect(dedupSymbolLinks([a, b])[0]!.viaUsage).toEqual([{ file: "ClubPage.tsx", line: 7 }, { file: "ClubPage.tsx", line: 12 }]);
    expect(dedupSymbolLinks([a, link("ConfirmDialog.tsx", "handleOk", "ClubPage.tsx", "saveClub")])[0]!.viaUsage).toBeUndefined();
  });
});
