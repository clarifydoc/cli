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
  it("types each lambda's parameter by its own source, never one for both", () => {
    // Two calls of one name on one line collapse into one link, the first lambda's.
    expect(targets(summary, "Board.twoSources", "p.sign")).toEqual(["Club.sign:injection"]);
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
  fun arms(o: Any) { when (o) { is Club -> o.scout(); is Decoy -> o.code(); else -> o.rich() }; o.sign() }
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
  it("types each call by the region that narrows its receiver, and none outside one", () => {
    expect(targets(summary, "Board.leaky", "o.scout")).toEqual(["Club.scout:injection"]);
    expect(targets(summary, "Board.leaky", "o.sign")).toEqual([]);
    expect(targets(summary, "Board.arms", "o.scout")).toEqual(["Club.scout:injection"]);
    expect(targets(summary, "Board.arms", "o.code")).toEqual(["Decoy.code:injection"]);
    expect(targets(summary, "Board.arms", "o.rich")).toEqual([]);
    expect(targets(summary, "Board.arms", "o.sign")).toEqual([]);
  });
  it("types an index and a first() receiver, and a caught exception", () => {
    expect(targets(summary, "Board.index", "clubs[0].sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.first", "clubs.firstOrNull()?.scout")).toEqual(["Club.scout:injection"]);
    expect(targets(summary, "Board.caught", "e.code")).toEqual(["LeagueException.code:injection"]);
  });
  it("types each lambda's `it` by its own source, and nothing where the source is unknown", () => {
    expect(targets(summary, "Board.twoSources", "it.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "Board.unknownIt", "it.sign")).toEqual([]);
  });
});

describe("Kotlin operator invoke and implicit receivers; Java annotation members, enum constant bodies and outer fields", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "league/Club.kt": "package league\nclass Club { fun sign() {}; fun scout() {} }\nclass Decoy { fun sign() {}; fun scout() {}; fun call(n: Int) = n }\nclass Whistle { operator fun invoke(n: Int): Int = n }\n",
      "league/Board.kt": `package league
class Board {
  fun blow() { val w = Whistle(); w(1) }
  fun withClub() { with(Club()) { scout() } }
  fun applyClub() { Club().apply { sign() } }
  fun withName(club: Club) { with(club) { sign() } }
  fun outer() { with(Club()) { Club().run { scout() } } }
}
`,
      "league/Since.java": "package league;\npublic @interface Since { String value(); int major() default 1; }\n",
      "league/Note.java": "package league;\npublic class Note { public String value() { return \"\"; } public int major() { return 2; } }\n",
      "league/Squad.java": "package league;\npublic class Squad { public void sign() {} public void rank() {} }\n",
      "league/Table.java": `package league;
public class Table {
  enum Kind { FAST { void go() { pace(); } }, SLOW; void pace() {} }
  private Squad squad = new Squad();
  class Row { void work() { squad.sign(); } }
  void read(Since since) { since.value(); since.major(); }
}
`,
    }));
  });
  afterAll(async () => done());

  it("links `h(1)` on a value of a class type to its operator invoke", () => {
    expect(targets(summary, "Board.blow", "w.invoke")).toEqual(["Whistle.invoke:injection"]);
  });
  it("links a bare call inside with(x) / x.apply { } to the member of the receiver's class", () => {
    expect(targets(summary, "Board.withClub", "scout")).toEqual(["Club.scout:class-name"]);
    expect(targets(summary, "Board.applyClub", "sign")).toEqual(["Club.sign:class-name"]);
    expect(targets(summary, "Board.withName", "sign")).toEqual(["Club.sign:injection"]);
  });
  it("links an annotation element call to the @interface, never to a namesake", () => {
    expect(targets(summary, "Table.read", "since.value")).toEqual(["Since.value:injection"]);
    expect(targets(summary, "Table.read", "since.major")).toEqual(["Since.major:injection"]);
  });
  it("reads the methods an enum constant's body declares, and an outer field used in an inner class", () => {
    expect(targets(summary, "Kind.go", "pace")).toEqual(["Kind.pace:direct"]);
    expect(targets(summary, "Row.work", "squad.sign")).toEqual(["Squad.sign:injection"]);
  });
});
