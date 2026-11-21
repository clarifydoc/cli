import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** Field writes and thrown types: the class whose field is written, a namesake field of another class never listed. */
describe("member effects, end to end", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-effects-"));
    await mkdir(join(dir, "ts"), { recursive: true });
    await mkdir(join(dir, "jvm"), { recursive: true });
    await writeFile(join(dir, "ts", "club.ts"), [
      "export class Overdrawn extends Error {}",
      "export class Club {",
      '  status: string = "open";',
      "  budget = 0;",
      '  constructor(public name: string) { this.status = "new"; }',
      '  close(): void { this.status = "closed"; this.budget -= 1; }',
      '  fail(): void { throw new Overdrawn("x"); }',
      "}",
      "export class Garage {",
      '  status: string = "x";',
      '  open(): void { this.status = "open"; }',
      "}",
      "export class Elite extends Club {",
      '  promote(): void { this.status = "elite"; }',
      "}",
      "export class League {",
      "  club: Club;",
      "  rename(c: Club, g: Garage): void {",
      '    c.status = "renamed";',
      '    this.club.status = "lead";',
      '    g.status = "garaged";',
      "    const other = { status: 1 };",
      "    other.status = 2;",
      '    function inner(this: any) { this.status = "no"; }',
      "  }",
      '  plain(e: Error) { try { run(); } catch (err) { throw err; } throw new Error("plain"); }',
      "}",
    ].join("\n"));
    await writeFile(join(dir, "ts", "loose.js"), 'export function tag(club) { club.status = "tagged"; }\n');
    await writeFile(join(dir, "jvm", "Club.java"), [
      "package com.example.league;",
      "import java.io.IOException;",
      "public class Club {",
      "  String status; int points;",
      '  Club() { status = "new"; }',
      '  void close() throws IOException, Overdrawn { this.status = "closed"; points++; throw new Overdrawn("x"); }',
      '  void same(String status) { status = "param"; }',
      "}",
      'class Garage { String status; void open() { status = "open"; } }',
      'class Elite extends Club { void promote() { status = "elite"; } }',
      "class League {",
      "  Club club;",
      '  void rename(Club c, Garage g) { c.status = "r"; this.club.status = "lead"; g.status = "g"; }',
      "}",
      "class Overdrawn extends Exception {}",
    ].join("\n"));
    await writeFile(join(dir, "jvm", "Cup.kt"), [
      "package com.example.kt",
      "class Cup { var status = \"\"; var gate = 0",
      "  @Throws(java.io.IOException::class, Closed::class)",
      '  fun close() { this.status = "closed"; gate++; throw Closed("x") }',
      '  fun move(c: Cup) { c.status = "m"; status = "s" }',
      "}",
      "class Closed : Exception()",
      'class Hall { var status = ""; fun open() { status = "open" } }',
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writers = (cls: string, member: string, file: string): string[] =>
    (summary.fieldWrites ?? []).filter((w) => w.class === cls && w.member === member && w.classFile === file).map((w) => `${w.function}:${w.line}`).sort();

  it("lists the writers of one class's field and never a namesake's (TypeScript)", () => {
    expect(writers("Club", "status", "ts/club.ts")).toEqual(["Club.close:6", "Elite.promote:14", "League.rename:19", "League.rename:20"]);
    expect(writers("Garage", "status", "ts/club.ts")).toEqual(["Garage.open:11", "League.rename:21"]);
    expect(writers("Club", "budget", "ts/club.ts")).toEqual(["Club.close:6"]);
  });

  it("states no write from a constructor, an untyped receiver or a nested function", () => {
    const all = (summary.fieldWrites ?? []).filter((w) => w.file === "ts/club.ts" || w.file === "ts/loose.js");
    expect(all.some((w) => w.line === 5 || w.line === 22 || w.line === 23)).toBe(false);
    expect(all.some((w) => w.file === "ts/loose.js")).toBe(false);
  });

  it("resolves Java writes through this, bare fields, inherited fields and typed receivers", () => {
    expect(writers("Club", "status", "jvm/Club.java")).toEqual(["Club.close:6", "Elite.promote:10", "League.rename:13", "League.rename:13"]);
    expect(writers("Club", "points", "jvm/Club.java")).toEqual(["Club.close:6"]);
    expect(writers("Garage", "status", "jvm/Club.java")).toEqual(["Garage.open:9", "League.rename:13"]);
  });

  it("does not take a parameter named like a field for the field (Java)", () => {
    expect((summary.fieldWrites ?? []).some((w) => w.function === "Club.same")).toBe(false);
  });

  it("resolves Kotlin writes and keeps the namesake class apart", () => {
    expect(writers("Cup", "status", "jvm/Cup.kt")).toEqual(["Cup.close:4", "Cup.move:5", "Cup.move:5"]);
    expect(writers("Cup", "gate", "jvm/Cup.kt")).toEqual(["Cup.close:4"]);
    expect(writers("Hall", "status", "jvm/Cup.kt")).toEqual(["Hall.open:8"]);
  });

  it("lists thrown types with the project class they name and what the signature declares", () => {
    const rows = (summary.thrownTypes ?? []).map((t) => `${t.function} ${t.type}${t.declared ? " declared" : ""}${t.classFile ? ` -> ${t.classFile}` : ""}`).sort();
    expect(rows).toEqual([
      "Club.close IOException declared",
      "Club.close Overdrawn -> jvm/Club.java",
      "Club.close Overdrawn declared -> jvm/Club.java",
      "Club.fail Overdrawn -> ts/club.ts",
      "Cup.close Closed -> jvm/Cup.kt",
      "Cup.close Closed declared -> jvm/Cup.kt",
      "Cup.close java.io.IOException declared",
      "League.plain Error",
    ].sort());
  });
});
