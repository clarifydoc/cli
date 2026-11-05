import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** Kotlin receiver typing the linker reads off the syntax: member-first bare calls, `!is` guards, indexers, lambda scopes. */
describe("Kotlin receivers, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-kotlin-receivers-"));
    await mkdir(join(dir, "src", "commonMain", "kotlin", "league"), { recursive: true });
    await mkdir(join(dir, "src", "jvmMain", "kotlin", "league"), { recursive: true });
    await writeFile(join(dir, "src", "Scoreboard.kt"), [
      "package com.example.league",
      "fun kick(power: Int) {}",
      "class Striker {",
      "    fun kick(power: Int) {}",
      "    fun shoot() { kick(3) }",
      "}",
      "fun train() { kick(2) }",
    ].join("\n"));
    await writeFile(join(dir, "src", "Squad.kt"), [
      "package com.example.squad",
      "class Club { fun promote() {} }",
      "class Car { fun promote() {} }",
      "class Striker { fun score() {} }",
      "class Garage { fun score() {} }",
      "class League { operator fun get(i: Int): Striker = Striker() }",
      "class Ext { fun each(block: (Any) -> Unit) {} }",
    ].join("\n"));
    await writeFile(join(dir, "src", "Use.kt"), [
      "package com.example.squad",
      "fun early(x: Any) {",
      "    if (x !is Club) return",
      "    x.promote()",
      "}",
      "fun either(x: Any, stale: Boolean) {",
      "    if (x !is Club || stale) { return }",
      "    x.promote()",
      "}",
      "fun unguarded(x: Any) {",
      "    if (x !is Club) { log(x.hashCode()) }",
      "    x.promote()",
      "}",
      "fun indexed(league: League) {",
      "    league[3].score()",
      "}",
      "fun scopes(items: List<Club>, ext: Ext) {",
      "    items.forEach { it.promote() }",
      "    ext.each { it.promote() }",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "src", "commonMain", "kotlin", "league", "Whistle.kt"), [
      "package league",
      "expect class Whistle { fun blow(): String }",
      "expect fun kickoff(): Long",
      "class Referee(private val whistle: Whistle) { fun start() { whistle.blow(); kickoff() } }",
    ].join("\n"));
    await writeFile(join(dir, "src", "jvmMain", "kotlin", "league", "Whistle.jvm.kt"), [
      "package league",
      "actual class Whistle { actual fun blow(): String = \"jvm\" }",
      "actual fun kickoff(): Long = 1L",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reached = async (file: string, symbol: string, callName: string) => {
    const summary = await loadReportSummary(join(dir, "out"));
    return (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === file && l.sourceSymbol === symbol && l.callName === callName)
      .map((l) => `${l.targetFile}:${l.targetSymbol}`);
  };

  it("a bare call inside a class body is the class's member, outside it the free function", async () => {
    expect(await reached("src/Scoreboard.kt", "Striker.shoot", "kick")).toEqual(["src/Scoreboard.kt:Striker.kick"]);
    expect(await reached("src/Scoreboard.kt", "train", "kick")).toEqual(["src/Scoreboard.kt:kick"]);
  });

  it.each(["early", "either"])("`x !is Club` returning leaves %s's x a Club for the rest of the block", async (fn) => {
    expect(await reached("src/Use.kt", fn, "x.promote")).toEqual(["src/Squad.kt:Club.promote"]);
  });

  it("an `!is` check that does not leave the block types nothing", async () => {
    expect(await reached("src/Use.kt", "unguarded", "x.promote")).toEqual([]);
  });

  it("an index expression follows the operator `get`'s return type, not a namesake", async () => {
    expect(await reached("src/Use.kt", "indexed", "league[3].score")).toEqual(["src/Squad.kt:Striker.score"]);
  });

  it("`it` is typed inside the lambda that types it, whatever another lambda leaves untyped", async () => {
    const calls = await reached("src/Use.kt", "scopes", "it.promote");
    expect(calls).toEqual(["src/Squad.kt:Club.promote"]);
  });

  it("a call reaches the `expect` declaration and no `actual` of one source set", async () => {
    const common = "src/commonMain/kotlin/league/Whistle.kt";
    expect(await reached(common, "Referee.start", "whistle.blow")).toEqual([`${common}:Whistle.blow`]);
    expect(await reached(common, "Referee.start", "kickoff")).toEqual([`${common}:kickoff`]);
  });
});
