import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-jvm-unwrap-"));
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

describe("calls that take the value out of a JVM wrapper (join, get, block, orElseThrow, await)", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      [`${PKG}/Club.java`]: "package com.example.league;\npublic class Club { public void promote() {} public void relegate() {} }\n",
      // The namesake decoy: never reached through a wrapper of Club.
      [`${PKG}/Player.java`]: "package com.example.league;\npublic class Player { public void promote() {} public void relegate() {} }\n",
      // A project class's own `get()` keeps its declared return type: Player, not a wrapper's element.
      [`${PKG}/Holder.java`]: "package com.example.league;\npublic class Holder { public Player get() { return new Player(); } }\n",
      // A project generic with a `join()`: not a wrapper the manifest lists, so `join` unwraps nothing.
      [`${PKG}/Box.java`]: "package com.example.league;\npublic class Box<T> { public T join() { return null; } }\n",
      [`${PKG}/ClubRepo.java`]: `package com.example.league;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import reactor.core.publisher.Mono;
public class ClubRepo {
  public CompletableFuture<Club> findAsync(long id) { return null; }
  public Mono<Club> findMono(long id) { return null; }
  public Optional<Club> findOpt(long id) { return null; }
  public Holder current() { return new Holder(); }
  public Box<Club> boxed() { return new Box<>(); }
}
`,
      [`${PKG}/Season.java`]: `package com.example.league;
public class Season {
  private final ClubRepo repo = new ClubRepo();
  public void viaJoin(long id) { var c = repo.findAsync(id).join(); c.promote(); }
  public void viaGet(long id) throws Exception { var c = repo.findAsync(id).get(); c.promote(); }
  public void viaBlock(long id) { var c = repo.findMono(id).block(); c.promote(); }
  public void viaOpt(long id) { var c = repo.findOpt(id).orElseThrow(); c.promote(); }
  public void chained(long id) { repo.findAsync(id).join().relegate(); }
  public void viaHolder() { var p = repo.current().get(); p.promote(); }
  public void viaBox() { var b = repo.boxed().join(); b.promote(); }
  // A call named like an Object.prototype member after a call: no unwrapping call, and no crash.
  public void label(long id) { var s = repo.findAsync(id).toString(); s.trim(); var v = repo.current().valueOf(); v.promote(); }
}
`,
      "src/main/kotlin/league/Fixtures.kt": `package league
import kotlinx.coroutines.Deferred
class Pitch { fun mark() {} }
class Stand { fun mark() {} }
class PitchRepo { fun findAsync(id: Long): Deferred<Pitch> = TODO() }
class Fixtures(private val repo: PitchRepo) {
  suspend fun viaAwait(id: Long) { val p = repo.findAsync(id).await(); p.mark() }
}
`,
    }));
  }, 120_000);
  afterAll(async () => { await done(); });

  it("types a local by the wrapper's element after join, get, block and orElseThrow", () => {
    for (const fn of ["viaJoin", "viaGet", "viaBlock", "viaOpt"]) {
      expect(targets(summary, `Season.${fn}`, "c.promote"), fn).toEqual(["Club.promote"]);
    }
  });

  it("follows a call chain through the unwrapping call", () => {
    expect(targets(summary, "Season.chained", "repo.findAsync(id).join().relegate")).toEqual(["Club.relegate"]);
  });

  it("keeps a project class's own get() and never unwraps a type the manifest does not list", () => {
    expect(targets(summary, "Season.viaHolder", "p.promote")).toEqual(["Player.promote"]);
    expect(targets(summary, "Season.viaBox", "b.promote")).not.toContain("Club.promote");
  });

  it("takes no Object.prototype member for an unwrapping call", () => {
    // The analysis above would have thrown (`unwrap.includes is not a function`); the file still links.
    expect(targets(summary, "Season.viaJoin", "c.promote")).toEqual(["Club.promote"]);
  });

  it("reads Kotlin's await on a Deferred", () => {
    expect(targets(summary, "Fixtures.viaAwait", "p.mark")).toEqual(["Pitch.mark"]);
  });
});
