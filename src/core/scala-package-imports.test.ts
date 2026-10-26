import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Scala import names a package, which any directory may declare: a module
 * laid out as `modules/clubs/src/main/` declares `package league.clubs`. The
 * files of the packages a file imports — and of its own — are its evidence for
 * a unique-name method; a value named for its type (`clubApi`, `api` of a
 * `TransferApi`) is evidence too; a method no package in scope holds stays
 * unlinked (real-repo shape).
 */
const FILES: Record<string, string> = {
  "build.sbt": `lazy val root = project.in(file("."))\n`,
  "modules/clubs/src/main/ClubApi.scala": `package league.clubs

final class ClubApi:
  def promoteToTopFlight(id: String): Unit = ()
`,
  "modules/clubs/src/main/ClubRepo.scala": `package league.clubs

final class ClubRepo:
  def relegateFromTopFlight(id: String): Unit = ()
`,
  "modules/transfers/src/main/TransferApi.scala": `package league.transfers

final class TransferApi:
  def openWindow(): Unit = ()
`,
  "modules/stats/src/main/Pair.scala": `package league.stats

final case class Pair(a: Int, b: Int):
  def foldLeftPair(z: Int): Int = z
`,
  "app/controllers/Clubs.scala": `package controllers

import league.clubs.ClubRepo

final class Clubs(env: Env):
  def promote(id: String) =
    env.clubs.api.promoteToTopFlight(id)
  def relegate(id: String) =
    env.clubs.repo.relegateFromTopFlight(id)
  def window() =
    env.transfers.api.openWindow()
  def total(xs: List[Int]) =
    xs.foldLeftPair(0)
`,
};

describe("Scala package imports", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-scala-packages-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName.endsWith(callName));
    return link ? `${link.targetFile} ${link.targetSymbol} ${link.strategy}` : null;
  };

  it("links a unique method of a file in a package the caller imports", () => {
    expect(linkOf("Clubs.relegate", "repo.relegateFromTopFlight")).toBe(
      "modules/clubs/src/main/ClubRepo.scala ClubRepo.relegateFromTopFlight unique-global",
    );
  });

  it("links a unique method of the class a value is named for", () => {
    expect(linkOf("Clubs.window", "api.openWindow")).toBe("modules/transfers/src/main/TransferApi.scala TransferApi.openWindow unique-global");
  });

  it("leaves a method of a package the caller neither imports nor names unlinked", () => {
    expect(linkOf("Clubs.total", "xs.foldLeftPair")).toBeNull();
  });
});
