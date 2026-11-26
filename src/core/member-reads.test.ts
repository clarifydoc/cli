import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";
import { readersText } from "../mcp/tools/member-effects.js";

/** Property reads: the class that declares the property, a namesake property of another class never listed. */
describe("member reads, end to end", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-reads-"));
    await mkdir(join(dir, "ts"), { recursive: true });
    await mkdir(join(dir, "jvm"), { recursive: true });
    await writeFile(join(dir, "ts", "club.ts"), [
      "export class Car {",
      "  speed = 0;",
      "}",
      "export class Garage {",
      "  name = 'g';",
      "  car: Car = new Car();",
      "  describe(): string { return this.name; }",
      "  fast(): number { return this.car.speed; }",
      "}",
      "export class Club {",
      "  name = 'c';",
      "  garage: Garage = new Garage();",
      "  title(): string { return this.name + this.name; }",
      "  top(): number { return this.garage.car.speed + this.garage.name.length; }",
      "  rename(): void { this.name = 'x'; this.name += 'y'; }",
      "  call(): void { this.title(); this.garage.describe(); }",
      "}",
      "export class League {",
      "  scan(c: Club, g: Garage, u): string { return c.name + g.name + u.name; }",
      "  local(): string { const c: Club = new Club(); return c.name; }",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "jvm", "Club.java"), [
      "class Car { int speed; }",
      "class Garage { String name; Car car; String describe() { return this.name; } int fast() { return this.car.speed; } }",
      "class Club {",
      "  String name;",
      "  Garage garage;",
      "  String title() { return this.name; }",
      "  int top() { return this.garage.car.speed; }",
      "  void set() { this.name = \"x\"; this.garage.open(); }",
      "}",
      "class League { String scan(Club c, Garage g) { return c.name + g.name; } }",
    ].join("\n"));
    await writeFile(join(dir, "jvm", "Cup.kt"), [
      "class Pitch { var grass: Int = 0 }",
      "class Cup {",
      "  var name: String = \"\"",
      "  var pitch: Pitch = Pitch()",
      "  fun title(): String { return this.name }",
      "  fun grass(): Int { return this.pitch.grass }",
      "  fun call(): String { return name.trim() }",
      "}",
      "class Hall { var name: String = \"\" }",
      "class Referee { fun scan(c: Cup, h: Hall): String { return c.name + h.name } }",
    ].join("\n"));
    const out = join(dir, "out");
    await analyze({ projectRoot: dir, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    summary = (await loadReportSummary(out)) as ProjectAnalysis;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const readers = (cls: string, member: string, file: string): string[] =>
    (summary.fieldReads ?? []).filter((r) => r.class === cls && r.member === member && r.classFile === file).map((r) => `${r.function}:${r.line}`).sort();

  it("lists the readers of one class's property and never a namesake's (TypeScript)", () => {
    expect(readers("Club", "name", "ts/club.ts")).toEqual(["Club.rename:15", "Club.title:13", "League.local:20", "League.scan:19"]);
    expect(readers("Garage", "name", "ts/club.ts")).toEqual(["Club.top:14", "Garage.describe:7", "League.scan:19"]);
    expect(readers("Car", "speed", "ts/club.ts")).toEqual(["Garage.fast:8"]);
    expect(readers("Garage", "car", "ts/club.ts")).toEqual(["Club.top:14", "Garage.fast:8"]);
    expect(readers("Club", "garage", "ts/club.ts")).toEqual(["Club.call:16", "Club.top:14"]);
  });

  it("states no read of a method, a plain assignment target or an untyped receiver (TypeScript)", () => {
    const all = (summary.fieldReads ?? []).filter((r) => r.file === "ts/club.ts");
    expect(all.some((r) => r.member === "title" || r.member === "describe")).toBe(false);
    expect(all.filter((r) => r.function === "Club.rename" && r.line === 15)).toHaveLength(1);
    expect(all.some((r) => r.function === "League.scan" && r.member === "name" && r.class !== "Club" && r.class !== "Garage")).toBe(false);
  });

  it("lists Java readers through this, a field's object and typed parameters", () => {
    expect(readers("Club", "name", "jvm/Club.java")).toEqual(["Club.title:6", "League.scan:10"]);
    expect(readers("Garage", "name", "jvm/Club.java")).toEqual(["Garage.describe:2", "League.scan:10"]);
    expect(readers("Car", "speed", "jvm/Club.java")).toEqual(["Garage.fast:2"]);
    expect(readers("Club", "garage", "jvm/Club.java")).toEqual(["Club.set:8", "Club.top:7"]);
  });

  it("lists Kotlin readers and keeps the namesake class apart", () => {
    expect(readers("Cup", "name", "jvm/Cup.kt")).toEqual(["Referee.scan:10", "Cup.title:5"].sort());
    expect(readers("Hall", "name", "jvm/Cup.kt")).toEqual(["Referee.scan:10"]);
    expect(readers("Pitch", "grass", "jvm/Cup.kt")).toEqual(["Cup.grass:6"]);
  });

  it("answers `direction=readers` and stays capped", () => {
    const text = readersText(summary, "Garage.name", 1, "ts/club.ts");
    expect(text).toContain("Who reads Garage.name");
    expect(text).toContain("2 more");
  });
});
