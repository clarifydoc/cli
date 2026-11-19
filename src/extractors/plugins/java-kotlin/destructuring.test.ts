import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-kt-destructure-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetSymbol}:${l.strategy}`);

describe("Kotlin destructuring declarations", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "league/Club.kt": "package league\nclass Club { fun sign() {} }\nclass Player { fun sign() {} }\ndata class Match(val club: Club, val player: Player)\nclass Squad(val club: Club)\n",
      "league/Board.kt": `package league
fun pair(): Pair<Club, Player> = Pair(Club(), Player())
fun triple(): Triple<Club, Player, Club> = Triple(Club(), Player(), Club())
fun match(): Match = Match(Club(), Player())
fun unknown() = foreign()
fun first() { val (a, b) = pair(); a.sign() }
fun second() { val (a, b) = pair(); b.sign() }
fun third() { val (a, b, c) = triple(); c.sign() }
fun skipped() { val (_, b) = pair(); b.sign() }
fun record() { val (a, b) = match(); b.sign() }
fun recordFirst() { val (a, b) = match(); a.sign() }
fun undeclared() { val (a, b) = unknown(); a.sign() }
fun written() { val (a: Player, b) = pair(); a.sign() }
`,
    }));
  });
  afterAll(async () => { await done(); });

  it("types each name by its position in a Pair or Triple", () => {
    expect(targets(summary, "first", "a.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "second", "b.sign")).toEqual(["Player.sign:injection"]);
    expect(targets(summary, "third", "c.sign")).toEqual(["Club.sign:injection"]);
    expect(targets(summary, "skipped", "b.sign")).toEqual(["Player.sign:injection"]);
  });

  it("types the components of a data class by its constructor properties", () => {
    expect(targets(summary, "record", "b.sign")).toEqual(["Player.sign:injection"]);
    expect(targets(summary, "recordFirst", "a.sign")).toEqual(["Club.sign:injection"]);
  });

  it("links nothing when the call's type is unknown, and a written type wins", () => {
    expect(targets(summary, "undeclared", "a.sign")).toEqual([]);
    expect(targets(summary, "written", "a.sign")).toEqual(["Player.sign:injection"]);
  });
});
