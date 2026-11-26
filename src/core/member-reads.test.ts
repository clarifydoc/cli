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
    await mkdir(join(dir, "cs"), { recursive: true });
    await mkdir(join(dir, "py"), { recursive: true });
    await mkdir(join(dir, "php"), { recursive: true });
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
    await writeFile(join(dir, "cs", "Club.cs"), [
      "namespace League {",
      "  public class Pitch { public int Grass { get; set; } }",
      "  public class Hall { public string Name { get; set; } }",
      "  public class Club {",
      "    public string Name { get; set; }",
      "    public Pitch Pitch { get; set; }",
      "    public string Title() { return this.Name + this.Name; }",
      "    public int Grass() { return this.Pitch.Grass; }",
      "    public void Rename() { this.Name = \"x\"; this.Name += \"y\"; }",
      "    public void Call() { this.Title(); this.Pitch.ToString(); }",
      "    public string Bare() { return Name; }",
      "  }",
      "  public class Referee {",
      "    public string Scan(Club c, Hall h, object u) { var k = (Club)u; return c.Name + h.Name + u.ToString(); }",
      "    public string Local() { Club c = new Club(); return c.Name; }",
      "  }",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "py", "club.py"), [
      "from dataclasses import dataclass",
      "class Pitch:",
      "    grass: int = 0",
      "class Hall:",
      "    name: str = 'h'",
      "class Club:",
      "    name: str = 'c'",
      "    def __init__(self, pitch: Pitch):",
      "        self.pitch = pitch",
      "        self.rank = 1",
      "    def title(self):",
      "        return self.name + self.name",
      "    def grass(self):",
      "        return self.pitch.grass",
      "    def rename(self):",
      "        self.name = 'x'",
      "        self.rank += 1",
      "    def call(self):",
      "        self.title()",
      "        self.pitch.mow()",
      "@dataclass",
      "class Cup:",
      "    year: int",
      "    def label(self):",
      "        return self.year",
      "class Referee:",
      "    def scan(self, c: Club, h: Hall, u):",
      "        return c.name + h.name + u.name",
      "    def local(self):",
      "        c: Club = Club(None)",
      "        return c.name",
    ].join("\n"));
    await writeFile(join(dir, "php", "Club.php"), [
      "<?php",
      "class Pitch { public int $grass = 0; }",
      "class Hall { public string $name = 'h'; }",
      "class Club {",
      "  public string $name = 'c';",
      "  public int $rank = 1;",
      "  public function __construct(public Pitch $pitch) {}",
      "  public function title() { return $this->name . $this->name; }",
      "  public function grass() { return $this->pitch->grass; }",
      "  public function rename() { $this->name = 'x'; $this->rank += 1; }",
      "  public function call() { $this->title(); $this->pitch->mow(); }",
      "}",
      "class Referee {",
      "  public function scan(Club $c, Hall $h, $u) { return $c->name . $h->name . $u->name; }",
      "  public function local() { $c = new Club(new Pitch()); return $c->name; }",
      "}",
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

  it("lists C# readers through this, a field's object and typed parameters, never a namesake's", () => {
    expect(readers("Club", "Name", "cs/Club.cs")).toEqual(["Club.Rename:9", "Club.Title:7", "Referee.Local:15", "Referee.Scan:14"]);
    expect(readers("Hall", "Name", "cs/Club.cs")).toEqual(["Referee.Scan:14"]);
    expect(readers("Pitch", "Grass", "cs/Club.cs")).toEqual(["Club.Grass:8"]);
    expect(readers("Club", "Pitch", "cs/Club.cs")).toEqual(["Club.Call:10", "Club.Grass:8"]);
    const all = (summary.fieldReads ?? []).filter((r) => r.file === "cs/Club.cs");
    expect(all.some((r) => r.member === "Title")).toBe(false);
    expect(all.some((r) => r.function === "Club.Bare")).toBe(false);
  });

  it("lists Python readers through self, a typed parameter and a dataclass field, never a namesake's", () => {
    expect(readers("Club", "name", "py/club.py")).toEqual(["Club.title:12", "Referee.local:31", "Referee.scan:28"]);
    expect(readers("Hall", "name", "py/club.py")).toEqual(["Referee.scan:28"]);
    expect(readers("Pitch", "grass", "py/club.py")).toEqual(["Club.grass:14"]);
    expect(readers("Club", "pitch", "py/club.py")).toEqual(["Club.call:20", "Club.grass:14"]);
    expect(readers("Club", "rank", "py/club.py")).toEqual(["Club.rename:17"]);
    expect(readers("Cup", "year", "py/club.py")).toEqual(["Cup.label:25"]);
    const all = (summary.fieldReads ?? []).filter((r) => r.file === "py/club.py");
    expect(all.some((r) => r.member === "title" || r.member === "mow")).toBe(false);
    expect(all.some((r) => r.function === "Club.rename" && r.member === "name")).toBe(false);
  });

  it("lists PHP readers through $this, a typed parameter and a promoted property, never a namesake's", () => {
    expect(readers("Club", "name", "php/Club.php")).toEqual(["Club.title:8", "Referee.local:15", "Referee.scan:14"]);
    expect(readers("Hall", "name", "php/Club.php")).toEqual(["Referee.scan:14"]);
    expect(readers("Pitch", "grass", "php/Club.php")).toEqual(["Club.grass:9"]);
    expect(readers("Club", "pitch", "php/Club.php")).toEqual(["Club.call:11", "Club.grass:9"]);
    expect(readers("Club", "rank", "php/Club.php")).toEqual(["Club.rename:10"]);
    const all = (summary.fieldReads ?? []).filter((r) => r.file === "php/Club.php");
    expect(all.some((r) => r.member === "title" || r.member === "mow")).toBe(false);
    expect(all.some((r) => r.function === "Club.rename" && r.member === "name")).toBe(false);
  });

  it("answers `direction=readers` and stays capped", () => {
    const text = readersText(summary, "Garage.name", 1, "ts/club.ts");
    expect(text).toContain("Who reads Garage.name");
    expect(text).toContain("2 more");
  });
});
