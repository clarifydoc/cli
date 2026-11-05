import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

describe("C# foreach var, LINQ lambdas, catch and element access", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "League/Club.cs": `namespace League;
public class Club { public void Sign() {} public bool Rich => true; public void Scout() {} }
public class Decoy { public void Sign() {} public bool Rich => false; public void Scout() {} public int Code() => 1; }
public class LeagueException : System.Exception { public int Code() => 1; }
`,
    "League/Board.cs": `using System.Collections.Generic;
using System.Linq;
namespace League;
public class Board {
  private readonly List<Club> _squad = new();
  public IEnumerable<Club> Reserves { get; }
  void LoopVar(List<Club> clubs) { foreach (var k in clubs) { k.Sign(); } }
  void LoopArray(Club[] clubs) { foreach (var k in clubs) { k.Scout(); } }
  void LoopField() { foreach (var k in _squad) { k.Sign(); } }
  void LoopProperty() { foreach (var k in Reserves) { k.Scout(); } }
  void Linq(IEnumerable<Club> clubs) { clubs.Where(c => c.Rich).Select(c => c.Sign()); }
  void ForEachCall(List<Club> clubs) { clubs.ForEach(d => d.Scout()); }
  void Caught() { try { } catch (LeagueException e) { e.Code(); } }
  void ArrayIndex(Club[] clubs) { clubs[0].Sign(); }
  void ListIndex(List<Club> clubs) { clubs[0].Scout(); }
  void First(List<Club> clubs) { clubs.First().Sign(); }
  void TwoSources(List<Club> clubs, List<Decoy> ds) { clubs.ForEach(p => p.Sign()); ds.ForEach(p => p.Sign()); }
  void Unknown(Foo foo) { foo.Items.ForEach(c => c.Sign()); }
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cs-elements-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (from: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetSymbol}:${l.strategy}`);

  it("types a `var` foreach variable over a list, an array, a field or a property", () => {
    expect(target("Board.LoopVar", "k.Sign")).toEqual(["Club.Sign:injection"]);
    expect(target("Board.LoopArray", "k.Scout")).toEqual(["Club.Scout:injection"]);
    expect(target("Board.LoopField", "k.Sign")).toEqual(["Club.Sign:injection"]);
    expect(target("Board.LoopProperty", "k.Scout")).toEqual(["Club.Scout:injection"]);
  });
  it("types the parameter of a LINQ or ForEach lambda", () => {
    expect(target("Board.Linq", "c.Sign")).toEqual(["Club.Sign:injection"]);
    expect(target("Board.ForEachCall", "d.Scout")).toEqual(["Club.Scout:injection"]);
  });
  it("types a caught exception and an indexed or First() receiver", () => {
    expect(target("Board.Caught", "e.Code")).toEqual(["LeagueException.Code:injection"]);
    expect(target("Board.ArrayIndex", "clubs[0].Sign")).toEqual(["Club.Sign:injection"]);
    expect(target("Board.ListIndex", "clubs[0].Scout")).toEqual(["Club.Scout:injection"]);
    expect(target("Board.First", "clubs.First().Sign")).toEqual(["Club.Sign:injection"]);
  });
  it("types nothing where one name is bound to two element types or to an unknown source", () => {
    expect(target("Board.TwoSources", "p.Sign")).toEqual([]);
    expect(target("Board.Unknown", "c.Sign")).toEqual([]);
  });
});

describe("C# indexers and local functions", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "League/Roster.cs": `namespace League;
public class Player { public void Sign() {} }
public class Squad { public Player this[int i] => new Player(); }
public class Decoy { public void Sign() {} }
`,
    "League/Board.cs": `namespace League;
public class Board {
  void Indexer(Squad squad) { squad[3].Sign(); }
  void IndexerLocal(Squad squad) { var p = squad[3]; p.Sign(); }
  void Local() { Player Make() { return new Player(); } Make().Sign(); var q = Make(); q.Sign(); }
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cs-indexers-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (from: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetSymbol}:${l.strategy}`);

  it("types an indexer access through the indexer's declared return type", () => {
    expect(target("Board.Indexer", "squad.Item().Sign")).toEqual(["Player.Sign:injection"]);
    expect(target("Board.IndexerLocal", "p.Sign")).toEqual(["Player.Sign:injection"]);
  });
  it("types a call of a local function through its declared return type", () => {
    expect(target("Board.Local", "Make().Sign")).toEqual(["Player.Sign:injection"]);
    expect(target("Board.Local", "q.Sign")).toEqual(["Player.Sign:injection"]);
  });
});
