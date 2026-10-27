import { describe, expect, it } from "vitest";
import { patternCallName, recordPatternCalls, type CalleeSegment } from "./antlr-calls.js";

const id = (name: string, column = 0, colon = false): CalleeSegment => ({ kind: "id", name, line: 1, column, ...(colon ? { colon } : {}) });
const call: CalleeSegment = { kind: "call" };
const other: CalleeSegment = { kind: "other" };

describe("patternCallName", () => {
  it("names a selector path by its last two names, as the baseline pattern reads it", () => {
    expect(patternCallName([id("kickoff")], 3)?.name).toBe("kickoff");
    expect(patternCallName([id("s", 0), id("repo", 2), id("FindClub", 7)], 3)).toEqual({ name: "repo.FindClub", leafName: "FindClub", line: 1, column: 2 });
  });

  it("names a member called on a call's result as the chain, as deep as the chain patterns read", () => {
    expect(patternCallName([id("pb"), id("NewLeagueClient"), call, id("GetMatch")], 3)?.name).toBe("pb.NewLeagueClient().GetMatch");
    expect(patternCallName([id("league"), call, id("Club"), call, id("Squad"), call, id("Captain")], 3)?.name).toBe("league().Club().Squad().Captain");
    expect(patternCallName([id("a"), call, id("b"), call, id("c"), call, id("d"), call, id("e")], 3)).toBeNull();
    expect(patternCallName([id("league"), call, id("Club")], 0)).toBeNull();
  });

  it("names nothing a pattern cannot spell", () => {
    // `squad[0].Substitute(`, `(*Coach).Train(`, `league.Clubs.Get()()`, a head of three names
    expect(patternCallName([id("squad"), other, id("Substitute")], 3)).toBeNull();
    expect(patternCallName([other, id("Train")], 3)).toBeNull();
    expect(patternCallName([id("league"), id("Get"), call], 3)).toBeNull();
    expect(patternCallName([id("app"), id("league"), id("Clubs"), call, id("First")], 3)).toBeNull();
  });

  it("names a Lua method call by the method, which is all the baseline reads after a colon", () => {
    expect(patternCallName([id("garage"), id("pool"), id("lease", 12, true)], 0)).toEqual({ name: "lease", leafName: "lease", line: 1, column: 12 });
  });
});

describe("recordPatternCalls", () => {
  it("keeps the first of each name, and on one line the chains before the baseline's names", () => {
    const calls = recordPatternCalls([
      { name: "json.NewEncoder", leafName: "NewEncoder", line: 4, column: 1 },
      { name: "json.NewEncoder().Encode", leafName: "Encode", line: 4, column: 1 },
      { name: "kickoff", leafName: "kickoff", line: 2, column: 0 },
      { name: "kickoff", leafName: "kickoff", line: 9, column: 0 },
      { name: "if", leafName: "if", line: 3, column: 0 },
    ]);
    expect(calls.map((c) => `${c.name}@${c.line}`)).toEqual(["kickoff@2", "json.NewEncoder().Encode@4", "json.NewEncoder@4"]);
  });
});
