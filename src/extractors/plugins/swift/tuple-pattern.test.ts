import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { swiftTupleElements } from "./tuple-elements.js";

/** `let (club, player) = load()` over a declared tuple: each name takes the element at its position. */
const FILES: Record<string, string> = {
  "Sources/League/Club.swift": `class Club {
    func sign() {}
}

class Player {
    func sign() {}
}
`,
  "Sources/League/Board.swift": `func load() -> (Club, Player) { return (Club(), Player()) }
func loadNamed() -> (club: Club, player: Player) { return (Club(), Player()) }
func loadAsync() async -> (Club, Player) { return (Club(), Player()) }
func mixed() -> (Int, Player) { return (1, Player()) }
func one() -> Club { return Club() }

func first() { let (a, b) = load(); a.sign() }
func second() { let (a, b) = load(); b.sign() }
func named() { let (a, b) = loadNamed(); b.sign() }
func waits() async { let (a, b) = await loadAsync(); a.sign() }
func skipped() { var (_, b) = load(); b.sign() }
func offset() { let (n, p) = mixed(); p.sign() }
func annotated() { let (a, b): (Player, Club) = pairUp(); a.sign() }
func notATuple() { let (a, b) = one(); a.sign() }
func literal() { let (a, b) = (Club(), Player()); a.sign() }
`,
};

describe("Swift tuple patterns", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-swift-tuples-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (from: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetSymbol}:${l.strategy}`);

  it("types each name by its position, labelled or not", () => {
    expect(target("first", "a.sign")).toEqual(["Club.sign:injection"]);
    expect(target("second", "b.sign")).toEqual(["Player.sign:injection"]);
    expect(target("named", "b.sign")).toEqual(["Player.sign:injection"]);
    expect(target("skipped", "b.sign")).toEqual(["Player.sign:injection"]);
    expect(target("offset", "p.sign")).toEqual(["Player.sign:injection"]);
  });
  it("reads an awaited call and a written annotation", () => {
    expect(target("waits", "a.sign")).toEqual(["Club.sign:injection"]);
    expect(target("annotated", "a.sign")).toEqual(["Player.sign:injection"]);
  });
  it("types nothing over a non-tuple result or a literal", () => {
    expect(target("notATuple", "a.sign")).toEqual([]);
    expect(target("literal", "a.sign")).toEqual([]);
  });
  it("reads the elements of a tuple type", () => {
    expect(swiftTupleElements("(Club, Player)")).toEqual(["Club", "Player"]);
    expect(swiftTupleElements("(club: Club, byName: [String: Player])")).toEqual(["Club", "[String: Player]"]);
    expect(swiftTupleElements("(Club) -> Player")).toBeNull();
    expect(swiftTupleElements("(Club, Player)?")).toBeNull();
    expect(swiftTupleElements("Club")).toBeNull();
  });
});
