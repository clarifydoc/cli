import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { csharpTupleElements } from "./tuple-elements.js";

describe("C# value-tuple deconstruction", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "League/Club.cs": `namespace League;
public class Club { public void Sign() {} }
public class Player { public void Sign() {} }
public class Squad { public Club Club => null; public void Deconstruct(out Club a, out Player b) { a = null; b = null; } }
`,
    "League/Board.cs": `using System.Threading.Tasks;
namespace League;
public class Board {
  (Club, Player) Load() => (new Club(), new Player());
  (Club club, Player player) LoadNamed() => (new Club(), new Player());
  Task<(Club, Player)> LoadAsync() => null;
  (int, Player) Mixed() => (1, new Player());
  Squad Roster() => null;
  void First() { var (a, b) = Load(); a.Sign(); }
  void Second() { var (a, b) = Load(); b.Sign(); }
  void Named() { var (a, b) = LoadNamed(); b.Sign(); }
  void Awaited() { var (a, b) = AwaitLoad().Result; }
  async Task Waits() { var (a, b) = await LoadAsync(); a.Sign(); }
  void Discard() { var (_, b) = Load(); b.Sign(); }
  void Assigned() { (var a, var b) = Load(); b.Sign(); }
  void Offset() { var (n, p) = Mixed(); p.Sign(); }
  void Own() { var (a, b) = Roster(); a.Sign(); }
  Task<(Club, Player)> AwaitLoad() => null;
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cs-tuples-"));
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

  it("types each name of `var (a, b) = Load()` by its position", () => {
    expect(target("Board.First", "a.Sign")).toEqual(["Club.Sign:injection"]);
    expect(target("Board.Second", "b.Sign")).toEqual(["Player.Sign:injection"]);
    expect(target("Board.Named", "b.Sign")).toEqual(["Player.Sign:injection"]);
    expect(target("Board.Discard", "b.Sign")).toEqual(["Player.Sign:injection"]);
    expect(target("Board.Offset", "p.Sign")).toEqual(["Player.Sign:injection"]);
  });
  it("reads the tuple an awaited Task returns and a `(var a, var b) =` assignment", () => {
    expect(target("Board.Waits", "a.Sign")).toEqual(["Club.Sign:injection"]);
    expect(target("Board.Assigned", "b.Sign")).toEqual(["Player.Sign:injection"]);
  });
  it("types nothing over a class with its own Deconstruct", () => {
    expect(target("Board.Own", "a.Sign")).toEqual([]);
  });

  it("reads the element types of a tuple type", () => {
    expect(csharpTupleElements("(Club, Player)")).toEqual(["Club", "Player"]);
    expect(csharpTupleElements("(Club club, Dictionary<string, Player> byName)")).toEqual(["Club", "Dictionary<string, Player>"]);
    expect(csharpTupleElements("ValueTuple<Club, Player>")).toEqual(["Club", "Player"]);
    expect(csharpTupleElements("Club")).toBeNull();
    expect(csharpTupleElements("(Club, Player)?")).toBeNull();
    expect(csharpTupleElements("(Club)")).toBeNull();
  });
});
