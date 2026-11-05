import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-jvm-elements-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetSymbol}:${l.strategy}`);

describe("Java loop variables, lambda parameters, patterns, catch and element access", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "league/Club.java": "package league;\npublic class Club { public void sign() {} public boolean rich() { return true; } public void scout() {} }\n",
      "league/Decoy.java": "package league;\npublic class Decoy { public void sign() {} public boolean rich() { return false; } public void scout() {} public int code() { return 1; } }\n",
      "league/LeagueException.java": "package league;\npublic class LeagueException extends Exception { public int code() { return 1; } }\n",
      "league/Board.java": `package league;
import java.util.*;
public class Board {
  private List<Club> squad = new ArrayList<>();
  void loopVar(List<Club> clubs) { for (var k : clubs) { k.sign(); } }
  void loopField() { for (var k : squad) { k.rich(); } }
  void lambda(List<Club> clubs) { clubs.stream().forEach(c -> c.sign()); }
  void typedLambda(List<Club> clubs) { clubs.forEach((Club k) -> k.scout()); }
  void chain(List<Club> clubs) { clubs.stream().filter(c -> c.rich()).forEach(d -> d.scout()); }
  void patternVar(Object o) { if (o instanceof Club c) { c.sign(); } }
  void patternSwitch(Object o) { switch (o) { case Club c -> c.scout(); default -> {} } }
  void caught() { try { run(); } catch (LeagueException e) { e.code(); } }
  void listGet(List<Club> clubs) { clubs.get(0).sign(); }
  void mapGet(Map<String, Club> byName) { byName.get("a").scout(); }
  void optional(Optional<Club> o) { o.get().rich(); o.orElseThrow().sign(); }
  void mapForEach(Map<String, Club> byName) { byName.forEach((n, v) -> v.sign()); }
  void unknownSource(List<Decoy> ds, Map<String, Decoy> m) { ds.forEach(c -> c.sign()); m.forEach((n, v) -> v.sign()); }
  void twoSources(List<Club> clubs, List<Decoy> ds) { clubs.forEach(p -> p.sign()); ds.forEach(p -> p.sign()); }
  void run() throws LeagueException {}
}
`,
    }));
  });
  afterAll(async () => done());

  it("types a `var` loop variable over a typed parameter or field", () => {
    expect(targets(summary, "Board.loopVar", "k.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.loopField", "k.rich")).toEqual(["Club.rich:injection"]);
  });
  it("types a lambda parameter, typed or handed the element, through a stream chain", () => {
    expect(targets(summary, "Board.lambda", "c.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.typedLambda", "k.scout")).toEqual(["Club.scout:injection"]);
    expect(targets(summary, "Board.chain", "c.rich")).toEqual(["Club.rich:injection"]);
    expect(targets(summary, "Board.chain", "d.scout")).toEqual(["Club.scout:injection"]);
    expect(targets(summary, "Board.mapForEach", "v.sign")).toEqual(["Club.sign:injection"]);
  });
  it("types an instanceof pattern, a switch pattern and a caught exception", () => {
    expect(targets(summary, "Board.patternVar", "c.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.patternSwitch", "c.scout")).toEqual(["Club.scout:injection"]);
    expect(targets(summary, "Board.caught", "e.code")).toEqual(["LeagueException.code:injection"]);
  });
  it("types the receiver of an element access", () => {
    expect(targets(summary, "Board.listGet", "clubs.get(0).sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.mapGet", 'byName.get("a").scout')).toEqual(["Club.scout:injection"]);
    expect(targets(summary, "Board.optional", "o.get().rich")).toEqual(["Club.rich:injection"]);
    expect(targets(summary, "Board.optional", "o.orElseThrow().sign")).toEqual(["Club.sign:injection"]);
  });
  it("types nothing where one name is bound to two element types", () => {
    expect(targets(summary, "Board.twoSources", "p.sign")).toEqual([]);
  });
});

describe("Kotlin loop variables, callbacks, smart casts and element access", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "league/Club.kt": "package league\nclass Club { fun sign() {}; fun rich(): Boolean = true; fun scout() {} }\nclass Decoy { fun sign() {}; fun rich(): Boolean = false; fun scout() {}; fun code() = 1 }\nclass LeagueException : Exception() { fun code() = 1 }\n",
      "league/Board.kt": `package league
class Board(private val fleet: List<Club>) {
  fun loop(clubs: List<Club>) { for (k in clubs) { k.sign() } }
  fun primary() { for (k in fleet) { k.rich() } }
  fun implicitIt(clubs: List<Club>) { clubs.forEach { it.scout() } }
  fun named(clubs: List<Club>) { clubs.map { c -> c.rich() } }
  fun chain(clubs: List<Club>) { clubs.filter { it.rich() }.forEach { x -> x.sign() } }
  fun whenIs(o: Any) { when (o) { is Club -> o.sign(); else -> {} } }
  fun smart(o: Any) { if (o is Club) { o.scout() } }
  fun leaky(o: Any) { if (o is Club) { o.scout() } else { o.sign() } }
  fun index(clubs: List<Club>) { clubs[0].sign() }
  fun first(clubs: List<Club>) { clubs.firstOrNull()?.scout() }
  fun caught() { try { run() } catch (e: LeagueException) { e.code() } }
  fun byMap(byName: Map<String, Club>) { byName.forEach { (n, v) -> v.sign() } }
  fun letIt(c: Club?) { c?.let { it.rich() } }
  fun twoSources(clubs: List<Club>, ds: List<Decoy>) { clubs.forEach { it.sign() }; ds.forEach { it.sign() } }
  fun unknownIt(x: Foo) { x.items.forEach { it.sign() } }
}
`,
    }));
  });
  afterAll(async () => done());

  it("types a for loop variable and a lambda's `it` or named parameter", () => {
    expect(targets(summary, "Board.loop", "k.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.primary", "k.rich")).toEqual(["Club.rich:injection"]);
    expect(targets(summary, "Board.implicitIt", "it.scout")).toEqual(["Club.scout:injection"]);
    expect(targets(summary, "Board.named", "c.rich")).toEqual(["Club.rich:injection"]);
    expect(targets(summary, "Board.chain", "x.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.byMap", "v.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.letIt", "it.rich")).toEqual(["Club.rich:injection"]);
  });
  it("types a `when (x) { is T -> }` entry and an `if (x is T)` body", () => {
    expect(targets(summary, "Board.whenIs", "o.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.smart", "o.scout")).toEqual(["Club.scout:injection"]);
  });
  it("leaves a name typed only inside the narrowing, never where it is used outside it", () => {
    expect(targets(summary, "Board.leaky", "o.scout")).toEqual([]);
  });
  it("types an index and a first() receiver, and a caught exception", () => {
    expect(targets(summary, "Board.index", "clubs[0].sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.first", "clubs.firstOrNull()?.scout")).toEqual(["Club.scout:injection"]);
    expect(targets(summary, "Board.caught", "e.code")).toEqual(["LeagueException.code:injection"]);
  });
  it("types nothing where `it` is bound to two element types", () => {
    expect(targets(summary, "Board.twoSources", "it.sign")).toEqual([]);
    expect(targets(summary, "Board.unknownIt", "it.sign")).toEqual([]);
  });
});
