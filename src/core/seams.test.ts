import { describe, it, expect } from "vitest";
import { crossFileCallers, describeSeams, seamsOf } from "./seams.js";
import { buildSiblingGraph } from "./sibling-graph.js";
import { createEmptyAnalysis, type ResponsibilityProfile, type SymbolLink } from "../types/analysis.js";

const link = (sourceFile: string, sourceSymbol: string, targetFile: string, targetSymbol: string): SymbolLink =>
  ({ sourceFile, sourceSymbol, sourceLine: 1, callName: targetSymbol, targetFile, targetSymbol, targetLine: 1 }) as SymbolLink;

describe("seamsOf", () => {
  // A club service holding two separable jobs: squad registration and match-day ticketing.
  const file = "src/club-service.ts";
  const a = createEmptyAnalysis(file, "typescript");
  const fns: Array<[string, number, number]> = [
    ["registerPlayer", 1, 20], ["checkContract", 21, 30], ["savePlayer", 31, 40],
    ["sellTicket", 41, 70], ["priceSeat", 71, 80], ["printTicket", 81, 90], ["refundTicket", 91, 100],
    ["formatDate", 101, 103],
  ];
  a.functions = fns.map(([name, line, endLine]) => ({ name, line, endLine, params: [], calls: [], decorators: [], isAsync: false, isExported: true, returnType: null })) as never;
  const sameFile = [
    link(file, "registerPlayer", file, "checkContract"), link(file, "registerPlayer", file, "savePlayer"),
    link(file, "sellTicket", file, "priceSeat"), link(file, "sellTicket", file, "printTicket"), link(file, "refundTicket", file, "priceSeat"),
  ];
  const graph = buildSiblingGraph(a, sameFile)!;
  const callers = crossFileCallers([
    ...sameFile,
    link("src/routes/tickets.ts", "buy", file, "sellTicket"),
    link("src/routes/tickets.ts", "refund", file, "refundTicket"),
    link("src/jobs/season.ts", "rollover", file, "refundTicket"),
  ]);
  const profile = {
    filePath: file,
    evidence: [
      { kind: "database", source: "data-mutation", name: "players.insert", line: 35 },
      { kind: "http", source: "data-source", name: "POST /payments", line: 50 },
    ],
  } as unknown as ResponsibilityProfile;

  it("names each group, its span, its boundaries and its callers in other files", () => {
    const seams = seamsOf(a, graph, callers, profile);
    expect(seams).toEqual([
      { functions: ["sellTicket", "priceSeat", "printTicket", "refundTicket"], functionCount: 4, lines: 60, boundaries: ["http"], moves: 2, externalFacing: 2, callerFiles: 2 },
      { functions: ["registerPlayer", "checkContract", "savePlayer"], functionCount: 3, lines: 40, boundaries: ["database"], moves: 3, externalFacing: 0, callerFiles: 0 },
    ]);
    expect(describeSeams(seams)).toBe(
      "[sellTicket, priceSeat, printTicket +1] 4 functions, 60 lines, touches http; 2 called from 2 other file(s) · " +
        "[registerPlayer, checkContract, savePlayer] 3 functions, 40 lines, touches database; no caller in another file observed",
    );
  });

  it("finds no seam in a file whose call graph is one group", () => {
    const one = buildSiblingGraph(a, [...sameFile, link(file, "savePlayer", file, "sellTicket")])!;
    expect(seamsOf(a, one, callers, profile)).toEqual([]);
  });
});
