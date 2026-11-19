import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-jvm-results-"));
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

describe("an operator's result is typed where the declared types state it (Java)", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      [`${PKG}/Club.java`]: `package com.example.league;
import reactor.core.publisher.Mono;
public class Club {
  public Mono<Club> promote() { return null; }
  public Mono<League> leagueAsync() { return null; }
  public League league() { return null; }
  public void rename() {}
}
`,
      [`${PKG}/League.java`]: "package com.example.league;\npublic class League { public void relegate() {} }\n",
      [`${PKG}/Player.java`]: `package com.example.league;
import reactor.core.publisher.Mono;
public class Player {
  public Mono<Player> promote() { return null; }
  public Player league() { return null; }
  public void rename() {}
  public void relegate() {}
  public void retire() {}
}
`,
      [`${PKG}/ClubRepo.java`]: `package com.example.league;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
public interface ClubRepo { Mono<Club> findById(long id); Flux<Club> findAll(); }
`,
      [`${PKG}/PlayerRepo.java`]: "package com.example.league;\nimport reactor.core.publisher.Flux;\npublic interface PlayerRepo { Flux<Player> findAll(); }\n",
      [`${PKG}/Season.java`]: `package com.example.league;
public class Season {
  public void flatThenMap(ClubRepo repo, long id) { repo.findById(id).flatMap(club -> club.promote()).map(c -> c.rename()); }
  public void mapThenFlat(ClubRepo repo) { repo.findAll().map(c -> c.league()).doOnNext(l -> l.relegate()); }
  public void ref(ClubRepo repo) { repo.findAll().map(Club::league).subscribe(l -> l.relegate()); }
  public void flatAsync(ClubRepo repo) { repo.findAll().flatMap(c -> c.leagueAsync()).subscribe(l -> l.relegate()); }
  // A reference to another class's static method is no member of the element.
  public void staticRef(ClubRepo repo) { repo.findAll().map(Player::league).subscribe(l -> l.relegate()); }
  // The body is not a call on the parameter: the result is unknown.
  public void opaque(ClubRepo repo) { repo.findAll().map(c -> helper(c)).subscribe(l -> l.relegate()); }
}
`,
    }));
  });
  afterAll(async () => done());

  it("types the parameter after flatMap by the wrapper its body declares", () => {
    expect(targets(summary, "Season.flatThenMap", "c.rename")).toEqual(["Club.rename"]);
    expect(targets(summary, "Season.flatAsync", "l.relegate")).toEqual(["League.relegate"]);
  });

  it("types the parameter after map by the type its body declares, also through a method reference", () => {
    expect(targets(summary, "Season.mapThenFlat", "l.relegate")).toEqual(["League.relegate"]);
    expect(targets(summary, "Season.ref", "l.relegate")).toEqual(["League.relegate"]);
  });

  it("never reaches the namesake and stops where the types do not say", () => {
    expect(targets(summary, "Season.staticRef", "l.relegate")).toEqual([]);
    expect(targets(summary, "Season.opaque", "l.relegate")).toEqual([]);
    const decoy = summary.symbolLinks.filter((l) => l.sourceSymbol.startsWith("Season.") && l.targetSymbol.startsWith("Player.") && l.callName !== "Player.league");
    expect(decoy).toEqual([]);
  });
});

describe("a name several lambdas of one method bind from different sources (Java)", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      [`${PKG}/Club.java`]: "package com.example.league;\npublic class Club { public void rename() {} public void promote() {} }\n",
      [`${PKG}/Player.java`]: "package com.example.league;\npublic class Player { public void rename() {} public void retire() {} }\n",
      [`${PKG}/ClubRepo.java`]: "package com.example.league;\nimport reactor.core.publisher.Flux;\npublic interface ClubRepo { Flux<Club> findAll(); }\n",
      [`${PKG}/PlayerRepo.java`]: "package com.example.league;\nimport reactor.core.publisher.Flux;\npublic interface PlayerRepo { Flux<Player> findAll(); }\n",
      [`${PKG}/Season.java`]: `package com.example.league;
public class Season {
  public void both(ClubRepo clubs, PlayerRepo players) {
    clubs.findAll().subscribe(x -> x.promote());
    players.findAll().subscribe(x -> x.retire());
  }
}
`,
    }));
  });
  afterAll(async () => done());

  it("types each lambda's parameter by its own source", () => {
    expect(targets(summary, "Season.both", "x.promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.both", "x.retire")).toEqual(["Player.retire"]);
  });
});

describe("Kotlin scope functions and operator results", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "src/main/kotlin/league/Club.kt": "package league\nclass Club {\n  fun promote() {}\n  fun rename() {}\n  fun league(): League = League()\n}\n",
      "src/main/kotlin/league/League.kt": "package league\nclass League {\n  fun relegate() {}\n}\n",
      "src/main/kotlin/league/Player.kt": "package league\nclass Player {\n  fun promote() {}\n  fun rename() {}\n  fun relegate() {}\n  fun retire() {}\n  fun league(): Player = Player()\n}\n",
      "src/main/kotlin/league/Repo.kt": "package league\ninterface ClubRepo {\n  fun lookup(id: Long): Club?\n  fun loadAll(): List<Club>\n}\n",
      "src/main/kotlin/league/PlayerRepo.kt": "package league\ninterface PlayerRepo {\n  fun loadAll(): List<Player>\n}\n",
      "src/main/kotlin/league/Season.kt": `package league
class Season(private val repo: ClubRepo, private val players: PlayerRepo) {
  fun letIt() { repo.lookup(1)!!.let { it.promote() } }
  fun safeLet() { repo.lookup(1)?.let { it.promote() } }
  fun alsoNamed() { repo.lookup(1)?.also { c -> c.rename() } }
  fun letChain() { repo.lookup(1)!!.let { it.league() }.let { l -> l.relegate() } }
  fun mapChain() { repo.loadAll().map { it.league() }.forEach { l -> l.relegate() } }
  fun two() { repo.loadAll().forEach { x -> x.rename() }; players.loadAll().forEach { x -> x.retire() } }
}
`,
    }));
  });
  afterAll(async () => done());

  it("types let and also on a call's result by the receiver's own type", () => {
    expect(targets(summary, "Season.letIt", "it.promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.safeLet", "it.promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.alsoNamed", "c.rename")).toEqual(["Club.rename"]);
  });

  it("follows the value through a let and an element through map", () => {
    expect(targets(summary, "Season.letChain", "l.relegate")).toEqual(["League.relegate"]);
    expect(targets(summary, "Season.mapChain", "l.relegate")).toEqual(["League.relegate"]);
  });

  it("scopes one name bound by two lambdas to each lambda", () => {
    expect(targets(summary, "Season.two", "x.rename")).toEqual(["Club.rename"]);
    expect(targets(summary, "Season.two", "x.retire")).toEqual(["Player.retire"]);
    expect(summary.symbolLinks.filter((l) => l.sourceSymbol.startsWith("Season.") && l.targetSymbol.startsWith("Player.") && l.callName !== "x.retire")).toEqual([]);
  });
});
