import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-jvm-lambda-"));
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

describe("an operator lambda's parameter takes the element type of the wrapper it runs on (Java)", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      [`${PKG}/Club.java`]: "package com.example.league;\nimport reactor.core.publisher.Mono;\npublic class Club { public Mono<Club> promote() { return null; } public void relegate() {} }\n",
      [`${PKG}/Player.java`]: "package com.example.league;\nimport reactor.core.publisher.Mono;\npublic class Player { public Mono<Player> promote() { return null; } public void relegate() {} }\n",
      [`${PKG}/Box.java`]: "package com.example.league;\npublic class Box<T> { public Box<T> map(java.util.function.Function<T, T> f) { return this; } }\n",
      [`${PKG}/ClubRepo.java`]: `package com.example.league;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
public interface ClubRepo {
  Mono<Club> findById(long id);
  Flux<Club> findAll();
  CompletableFuture<Club> later(long id);
  Optional<Club> maybe(long id);
  List<Club> all();
  Box<Club> boxed();
}
`,
      [`${PKG}/Season.java`]: `package com.example.league;
public class Season {
  public void flat(ClubRepo repo, long id) { repo.findById(id).flatMap(club -> club.promote()); }
  public void flux(ClubRepo repo) { repo.findAll().doOnNext(c -> c.relegate()); }
  public void future(ClubRepo repo) { repo.later(1).thenAccept(c -> c.relegate()); }
  public void optional(ClubRepo repo) { repo.maybe(1).ifPresent(c -> c.relegate()); }
  public void stream(ClubRepo repo) { repo.all().stream().map(c -> c.promote()); }
  public void kept(ClubRepo repo) { repo.findAll().filter(c -> true).subscribe(c -> c.relegate()); }
  // An operator on an unlisted generic types nothing.
  public void box(ClubRepo repo) { repo.boxed().map(c -> c.relegate()); }
  // After \`map\` the declared types state no element: the chain stops.
  public void mapped(ClubRepo repo) { repo.findAll().map(c -> c.hashCode()).doOnNext(n -> n.relegate()); }
  // A written parameter type wins.
  public void explicit(ClubRepo repo) { repo.findAll().doOnNext((Player p) -> p.relegate()); }
}
`,
    }));
  });
  afterAll(async () => done());

  it("types the first parameter of flatMap, doOnNext, thenAccept, ifPresent and stream().map", () => {
    expect(targets(summary, "Season.flat", "club.promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.flux", "c.relegate")).toEqual(["Club.relegate"]);
    expect(targets(summary, "Season.future", "c.relegate")).toEqual(["Club.relegate"]);
    expect(targets(summary, "Season.optional", "c.relegate")).toEqual(["Club.relegate"]);
    expect(targets(summary, "Season.stream", "c.promote")).toEqual(["Club.promote"]);
  });

  it("reads past an operator that keeps the element", () => {
    expect(targets(summary, "Season.kept", "c.relegate")).toEqual(["Club.relegate"]);
  });

  it("never reaches the namesake and types nothing off an unlisted generic or after map", () => {
    expect(targets(summary, "Season.box", "c.relegate")).toEqual([]);
    expect(targets(summary, "Season.mapped", "n.relegate")).toEqual([]);
    expect(targets(summary, "Season.explicit", "p.relegate")).toEqual(["Player.relegate"]);
    const all = summary.symbolLinks.filter((l) => l.sourceSymbol.startsWith("Season.") && l.targetSymbol === "Player.promote");
    expect(all).toEqual([]);
  });
});

describe("an operator lambda's parameter takes the element type of the wrapper it runs on (Kotlin)", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "src/main/kotlin/league/Club.kt": "package league\nclass Club {\n  fun promote() {}\n  fun relegate() {}\n}\n",
      "src/main/kotlin/league/Player.kt": "package league\nclass Player {\n  fun promote() {}\n  fun relegate() {}\n}\n",
      "src/main/kotlin/league/Repo.kt": `package league
import kotlinx.coroutines.flow.Flow
interface ClubRepo { fun findAll(): Flow<Club>; fun load(): List<Club> }
`,
      "src/main/kotlin/league/Season.kt": `package league
class Season(private val repo: ClubRepo) {
  suspend fun flow() { repo.findAll().collect { club -> club.promote() } }
  fun each() { repo.load().forEach { c -> c.relegate() } }
}
`,
    }));
  });
  afterAll(async () => done());

  it("types a Flow collector parameter", () => {
    expect(targets(summary, "Season.flow", "club.promote")).toEqual(["Club.promote"]);
    expect(targets(summary, "Season.each", "c.relegate")).toEqual(["Club.relegate"]);
  });
});
