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
    await mkdir(join(dir, "cs"), { recursive: true });
    await writeFile(join(dir, "cs", "Club.cs"), [
      "namespace League {",
      "public class Overdrawn : System.Exception {}",
      "public class Club {",
      "  public string Status { get; set; }",
      "  public int Points;",
      '  public Club() { Status = "new"; }',
      '  public void Close() { this.Status = "closed"; Points++; throw new Overdrawn(); }',
      '  public void Same(string Status) { Status = "param"; }',
      "  public void Again() { try { Close(); } catch (System.Exception e) { throw; } }",
      "}",
      'public class Garage { public string Status; public void Open() { Status = "open"; } }',
      'public class Elite : Club { public void Promote() { Status = "elite"; } }',
      "public class Division {",
      "  private Club club;",
      '  public void Rename(Club c, Garage g, Other o) { c.Status = "r"; this.club.Status = "lead"; g.Status = "g"; o.Status = "o"; var u = Make(); u.Status = "u"; }',
      "}",
      "public class Other { public string Status; }",
      "}",
    ].join("\n"));
    await mkdir(join(dir, "py"), { recursive: true });
    await writeFile(join(dir, "py", "club.py"), [
      "class Overdrawn(Exception):",
      "    pass",
      "",
      "class Club:",
      "    def __init__(self, name):",
      "        self.status = 'new'",
      "    def close(self):",
      "        self.status = 'closed'",
      "        self.points += 1",
      "        raise Overdrawn('x')",
      "    def same(self, status):",
      "        status = 'param'",
      "    def again(self, err):",
      "        try:",
      "            self.close()",
      "        except Exception as e:",
      "            raise",
      "        raise err",
      "    def fail(self):",
      "        raise Overdrawn",
      "",
      "class Garage:",
      "    def __init__(self):",
      "        self.status = 'x'",
      "    def open(self):",
      "        self.status = 'open'",
      "",
      "class Elite(Club):",
      "    def promote(self):",
      "        self.status = 'elite'",
      "",
      "class Division:",
      "    def __init__(self, club: Club):",
      "        self.club = club",
      "    def rename(self, c: Club, g: Garage, o, h: 'Garage'):",
      "        c.status = 'r'",
      "        self.club.status = 'lead'",
      "        g.status = 'g'",
      "        o.status = 'untyped'",
      "        make().status = 'call'",
      "        errors.Overdrawn",
      "        raise errors.Overdrawn()",
      "",
      "def adjust(g: Garage):",
      "    g.status = 'free'",
      "",
    ].join("\n"));
    await writeFile(join(dir, "ts", "doc.js"), [
      "export class Offside extends Error {}",
      "/**",
      " * @param {number} n",
      " * @throws {Offside} when late",
      " * @throws {Object<string>} nothing",
      " */",
      "export function flag(n) { return helper(n); }",
      "export class Referee {",
      "  /** @throws {Offside|Foul} */",
      "  call() { throw new Offside(); }",
      "}",
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

  it("resolves C# writes through this, bare members, inherited members and typed receivers", () => {
    expect(writers("Club", "Status", "cs/Club.cs")).toEqual(["Club.Close:7", "Division.Rename:15", "Division.Rename:15", "Elite.Promote:12"]);
    expect(writers("Club", "Points", "cs/Club.cs")).toEqual(["Club.Close:7"]);
    expect(writers("Garage", "Status", "cs/Club.cs")).toEqual(["Division.Rename:15", "Garage.Open:11"]);
    expect(writers("Other", "Status", "cs/Club.cs")).toEqual(["Division.Rename:15"]);
    expect((summary.fieldWrites ?? []).some((w) => w.function === "Club.Same" || w.function === "Club.Club")).toBe(false);
  });

  it("resolves Python writes through self, inherited attributes and typed receivers", () => {
    expect(writers("Club", "status", "py/club.py")).toEqual(["Club.close:8", "Division.rename:36", "Division.rename:37", "Elite.promote:30"]);
    expect(writers("Club", "points", "py/club.py")).toEqual(["Club.close:9"]);
    expect(writers("Garage", "status", "py/club.py")).toEqual(["Division.rename:38", "Garage.open:26", "adjust:45"]);
    expect((summary.fieldWrites ?? []).some((w) => w.file === "py/club.py" && (w.function === "Club.same" || w.line === 39 || w.line === 40))).toBe(false);
  });

  it("reads a JSDoc @throws as a declared thrown type, beside the body's own throws", () => {
    const rows = (summary.thrownTypes ?? []).filter((t) => t.file === "ts/doc.js").map((t) => `${t.function} ${t.type}${t.declared ? " declared" : ""}:${t.line}`).sort();
    expect(rows).toEqual(["Referee.call Foul declared:10", "Referee.call Offside declared:10", "Referee.call Offside:10", "flag Offside declared:7"]);
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
      "Club.Close Overdrawn -> cs/Club.cs",
      "Club.close Overdrawn -> py/club.py",
      "Club.fail Overdrawn -> py/club.py",
      "Division.rename errors.Overdrawn -> py/club.py",
      "League.plain Error",
      "Referee.call Foul declared",
      "Referee.call Offside -> ts/doc.js",
      "Referee.call Offside declared -> ts/doc.js",
      "flag Offside declared -> ts/doc.js",
    ].sort());
  });
});

/** PHP: properties written through `$this`, static properties, typed receivers; thrown classes bound by `use` and namespace. */
describe("member effects, PHP", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-effects-php-"));
    await mkdir(join(dir, "app", "Models"), { recursive: true });
    await mkdir(join(dir, "app", "Exceptions"), { recursive: true });
    await mkdir(join(dir, "app", "Other"), { recursive: true });
    await writeFile(join(dir, "app", "Exceptions", "ClubNotFound.php"), "<?php\nnamespace App\\Exceptions;\nclass ClubNotFound extends \\Exception {}\n");
    await writeFile(join(dir, "app", "Other", "ClubNotFound.php"), "<?php\nnamespace App\\Other;\nclass ClubNotFound extends \\Exception {}\n");
    await writeFile(join(dir, "app", "Models", "Club.php"), [
      "<?php",
      "namespace App\\Models;",
      "use App\\Exceptions\\ClubNotFound;",
      "class Club {",
      '    public string $name = "";',
      "    public static int $count = 0;",
      "    public int $points = 0;",
      '    public function __construct(string $n) { $this->name = $n; }',
      "    /** @throws ClubNotFound */",
      "    public function rename(string $n): void {",
      "        $this->name = $n;",
      "        self::$count++;",
      "        static::$count = 5;",
      "        $f = 'name';",
      "        $this->$f = 'x';",
      "        $this->points += 1;",
      '        throw new ClubNotFound("x");',
      "    }",
      '    public function fail() { throw new \\App\\Other\\ClubNotFound(); }',
      "}",
      "class Garage { public string $name = ''; public function open() { $this->name = 'o'; } }",
    ].join("\n"));
    await writeFile(join(dir, "app", "Models", "Elite.php"), "<?php\nnamespace App\\Models;\nclass Elite extends Club { public function promote() { $this->points = 9; } }\n");
    await writeFile(join(dir, "app", "Models", "League.php"), [
      "<?php",
      "namespace App\\Models;",
      "class League {",
      "    public Club $club;",
      "    public function move(Club $c, Garage $g, $o) {",
      "        $c->name = 'r'; $c->points++; $g->name = 'g'; $o->name = 'u';",
      "        $this->club->name = 'lead';",
      "        $v = new Club('a'); $v->name = 'z';",
      "    }",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writers = (cls: string, member: string): string[] =>
    (summary.fieldWrites ?? []).filter((w) => w.class === cls && w.member === member).map((w) => `${w.function}:${w.line}`).sort();

  it("lists the writers of a property through this, a static scope, inheritance and typed receivers", () => {
    expect(writers("Club", "name")).toEqual(["Club.rename:11", "League.move:6", "League.move:7", "League.move:8"]);
    expect(writers("Club", "points")).toEqual(["Club.rename:16", "Elite.promote:3", "League.move:6"]);
    expect(writers("Club", "count")).toEqual(["Club.rename:12", "Club.rename:13"]);
    expect(writers("Garage", "name")).toEqual(["Garage.open:21", "League.move:6"]);
  });

  it("states nothing for a constructor, a dynamic property or an untyped receiver", () => {
    const rows = (summary.fieldWrites ?? []).filter((w) => w.file === "app/Models/Club.php");
    expect(rows.some((w) => w.line === 8 || w.line === 15)).toBe(false);
    expect((summary.fieldWrites ?? []).some((w) => w.function === "League.move" && w.class !== "Club" && w.class !== "Garage")).toBe(false);
  });

  it("binds a thrown class through the file's use and namespace, and the docblock as declared", () => {
    const rows = (summary.thrownTypes ?? []).map((t) => `${t.function} ${t.type}${t.declared ? " declared" : ""} -> ${t.classFile}`).sort();
    expect(rows).toEqual([
      "Club.fail \\App\\Other\\ClubNotFound -> app/Other/ClubNotFound.php",
      "Club.rename ClubNotFound -> app/Exceptions/ClubNotFound.php",
      "Club.rename ClubNotFound declared -> app/Exceptions/ClubNotFound.php",
    ]);
  });
});
