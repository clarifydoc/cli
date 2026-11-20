import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-element-calls-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => l.targetSymbol).sort();

const PKG = "src/main/java/com/example/league";

describe("an element taken out of a declared list or map, and a map entry's value", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      [`${PKG}/Club.java`]: "package com.example.league;\npublic class Club { public void promote() {} }\n",
      // The namesake decoy: never reached through a collection of Club.
      [`${PKG}/Player.java`]: "package com.example.league;\npublic class Player { public void promote() {} }\n",
      // A project class with its own `get(int)` keeps its declared return type.
      [`${PKG}/Roster.java`]: "package com.example.league;\npublic class Roster { public Player get(int i) { return null; } }\n",
      [`${PKG}/ClubRepo.java`]: `package com.example.league;
import java.util.*;
public class ClubRepo {
  public List<Club> all() { return null; }
  public Map<String, Club> byName() { return null; }
  public Roster roster() { return null; }
  public List<Club> clubs;
}
`,
      [`${PKG}/Season.java`]: `package com.example.league;
import java.util.*;
public class Season {
  private ClubRepo repo;
  private Map<String, Club> byName;
  public void localList() { var l = repo.all(); l.get(0).promote(); }
  public void chainList() { repo.all().get(0).promote(); }
  public void chainMap() { repo.byName().get("x").promote(); }
  public void localMap() { var m = repo.byName(); m.get("x").promote(); }
  public void field(ClubRepo r) { r.clubs.get(0).promote(); }
  public void elementLocal() { var c = repo.all().get(1); c.promote(); }
  public void own() { repo.roster().get(0).promote(); }
  public void entryVar(Map<String, Club> m) { for (var en : m.entrySet()) en.getValue().promote(); }
  public void entryTyped(Map<String, Club> m) { for (Map.Entry<String, Club> en : m.entrySet()) en.getValue().promote(); }
  public void entryField() { for (var en : byName.entrySet()) en.getValue().promote(); }
  public void entryKey(Map<Club, Player> m) { for (var en : m.entrySet()) { en.getKey().promote(); en.getValue().promote(); } }
  public void entryTwice(Map<String, Club> m, Map<String, Player> p) {
    for (var en : m.entrySet()) en.getValue().promote();
    for (var en : p.entrySet()) en.getValue().promote();
  }
}
`,
      "kt/Pitch.kt": `package league
class Turf { fun reload() {} }
class Stand { fun reload() {} }
class Pitches { fun all(): List<Turf> = listOf(); fun byName(): Map<String, Turf> = mapOf() }
class Stands { fun get(i: Int): Stand = Stand() }
class Settings { val turf: Turf = Turf() }
`,
      "kt/Use.kt": `package league
class Use(val repo: Pitches, val settings: Settings, val byName: Map<String, Turf>) {
  fun lazyLocal(lazy: Lazy<Turf>) { val s = lazy.value; s.reload() }
  fun memberLocal() { val t = settings.turf; t.reload() }
  fun localList() { val l = repo.all(); l.get(0).reload(); l[0].reload() }
  fun chainList() { repo.all().get(0).reload(); repo.all()[0].reload() }
  fun chainMap() { repo.byName()["x"]!!.reload() }
  fun indexedLocal() { val c = repo.all()[1]; c.reload() }
  fun own(stands: Stands) { stands.get(0).reload(); stands[0].reload() }
  fun entries() { for (e in byName.entries) e.value.reload() }
  fun direct(m: Map<String, Turf>) { for (en in m) en.value.reload() }
}
`,
      "cs/Club.cs": `namespace League {
  public class Manager { public void Promote() {} }
  public class Coach { public void Promote() {} }
  public class Club { public Manager Boss { get; } public Coach Assistant { get; } public static int Founded = 1900; }
  public class Season {
    private Club _club;
    public void Read() { var m = _club.Boss; m.Promote(); }
    public void Chain(Club club) { var a = club.Assistant; a.Promote(); }
    public void Const() { var y = Club.Founded; y.ToString(); }
  }
}
`,
    }));
  });
  afterAll(() => done());

  it("types a list element read off a call's result, a local or a field", () => {
    expect(targets(summary, "Season.localList", "l.get(0).promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.chainList", "repo.all().get(0).promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.field", "r.clubs.get(0).promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.elementLocal", "c.promote")).toEqual(["Club.promote"]);
  });
  it("types a map's value, not its key", () => {
    expect(targets(summary, "Season.chainMap", 'repo.byName().get("x").promote')).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.localMap", 'm.get("x").promote')).toEqual(["Club.promote"]);
  });
  it("keeps a project class's own get()", () => {
    expect(targets(summary, "Season.own", "repo.roster().get(0).promote")).toEqual(["Player.promote"]);
    expect(targets(summary, "Use.own", "stands.get(0).reload")).toEqual(["Stand.reload"]);
    expect(targets(summary, "Use.own", "stands[0].reload")).toEqual(["Stand.reload"]);
  });
  it("types a map entry's value and key in a loop over the map's entries", () => {
    expect(targets(summary, "Season.entryVar", "en.getValue().promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.entryTyped", "en.getValue().promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.entryField", "en.getValue().promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.entryKey", "en.getKey().promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.entryKey", "en.getValue().promote")).toEqual(["Player.promote"]);
  });
  it("types no entry a name binds to two different maps", () => {
    expect(targets(summary, "Season.entryTwice", "en.getValue().promote")).toEqual([]);
  });
  it("types a Kotlin lazy.value local, a member-read local and an indexed element", () => {
    expect(targets(summary, "Use.lazyLocal", "s.reload")).toEqual(["Turf.reload"]);
    expect(targets(summary, "Use.memberLocal", "t.reload")).toEqual(["Turf.reload"]);
    expect(targets(summary, "Use.localList", "l.get(0).reload")).toEqual(["Turf.reload"]);
    expect(targets(summary, "Use.localList", "l[0].reload")).toEqual(["Turf.reload"]);
    expect(targets(summary, "Use.chainList", "repo.all().get(0).reload")).toEqual(["Turf.reload"]);
    expect(targets(summary, "Use.chainList", "repo.all()[0].reload")).toEqual(["Turf.reload"]);
    expect(targets(summary, "Use.chainMap", 'repo.byName()["x"]!!.reload')).toEqual(["Turf.reload"]);
    expect(targets(summary, "Use.indexedLocal", "c.reload")).toEqual(["Turf.reload"]);
  });
  it("types a Kotlin entry's value", () => {
    expect(targets(summary, "Use.entries", "e.value.reload")).toEqual(["Turf.reload"]);
    expect(targets(summary, "Use.direct", "en.value.reload")).toEqual(["Turf.reload"]);
  });
  it("types a C# local from any plain member read, and a constant's member nothing", () => {
    expect(targets(summary, "Season.Read", "m.Promote")).toEqual(["Manager.Promote"]);
    expect(targets(summary, "Season.Chain", "a.Promote")).toEqual(["Coach.Promote"]);
    expect(summary.symbolLinks.filter((l) => l.sourceSymbol === "Season.Const" && l.callName === "y.ToString")).toEqual([]);
  });
});
