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
      "    public array $items = [];",
      "    public function add($i) { $this->items[] = $i; }",
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

  const writers = (cls: string, member: string, file?: string): string[] =>
    (summary.fieldWrites ?? []).filter((w) => w.class === cls && w.member === member && (!file || w.classFile === file)).map((w) => `${w.function}:${w.line}`).sort();

  it("lists the writers of a property through this, a static scope, inheritance and typed receivers", () => {
    expect(writers("Club", "name")).toEqual(["Club.rename:11", "League.move:10", "League.move:8", "League.move:9"]);
    expect(writers("Club", "points")).toEqual(["Club.rename:16", "Elite.promote:3", "League.move:8"]);
    expect(writers("Club", "count")).toEqual(["Club.rename:12", "Club.rename:13"]);
    expect(writers("Garage", "name", "app/Models/Club.php")).toEqual(["Garage.open:21", "League.move:8"]);
    expect(writers("League", "items")).toEqual(["League.add:6"]);
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

/** Go: fields written through the receiver, typed parameters and locals; package variables joined to the file that declares them. */
describe("member effects, Go", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-effects-go-"));
    await mkdir(join(dir, "league"), { recursive: true });
    await mkdir(join(dir, "garage"), { recursive: true });
    await writeFile(join(dir, "go.mod"), "module example.com/league\n\ngo 1.21\n");
    await writeFile(join(dir, "league", "club.go"), [
      "package league",
      "",
      "var clubCount = 0",
      "var (",
      "\tcache = map[string]*Club{}",
      "\tready bool",
      ")",
      "",
      "type Stats struct{ Goals int }",
      "",
      "type Base struct{ ID int }",
      "",
      "type Club struct {",
      "\tBase",
      "\tName  string",
      "\tScore int",
      "\tStats *Stats",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "league", "ops.go"), [
      "package league",
      "",
      "import \"example.com/lib\"",
      "",
      "func (c *Club) Rename(n string) {",
      "\tc.Name = n",
      "\tc.Stats.Goals = 0",
      "\tc.ID = 7",
      "\tclubCount++",
      "}",
      "",
      "func Score(p *Club, cfg *lib.Config) {",
      "\tp.Score += 1",
      "\tcfg.Name = \"x\"",
      "\tcache[p.Name] = p",
      "}",
      "",
      "func Fresh() *Club {",
      "\tclubCount := 3",
      "\tclubCount = 4",
      "\tc := &Club{}",
      "\tc.Name = \"a\"",
      "\tready = true",
      "\treturn c",
      "}",
      "",
      "func Shadow(ready bool) {",
      "\tready = false",
      "}",
      "",
      "func (c *Club) Total() (clubCount int) {",
      "\tclubCount = 2",
      "\treturn",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "league", "more.go"), [
      "package league",
      "",
      "func Update(",
      "\tclubCount int,",
      "\tready bool,",
      ") {",
      "\tclubCount = clubCount + 1",
      "\tready = true",
      "}",
      "",
      "func Local() {",
      "\tvar (",
      "\t\tcache = 1",
      "\t)",
      "\tcache = 2",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "league", "ops_test.go"), "package league\n\nfunc resetCount() {\n\tclubCount = 0\n}\n");
    await writeFile(join(dir, "garage", "garage.go"), [
      "package garage",
      "",
      "var clubCount = 1",
      "",
      "type Club struct{ Name string }",
      "",
      "func (c *Club) Rename(n string) {",
      "\tc.Name = n",
      "\tclubCount = 5",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (): string[] =>
    (summary.fieldWrites ?? []).map((w) => `${w.class}.${w.member} <- ${w.function}:${w.line} ${w.via} ${w.classFile}`).sort();

  it("lists struct fields written through the receiver, a typed parameter and a typed local, in the package's own type", () => {
    expect(rows().filter((r) => r.includes("league/club.go") && !r.includes("package"))).toEqual([
      "Base.ID <- Club.Rename:8 this league/club.go",
      "Club.Name <- Club.Rename:6 this league/club.go",
      "Club.Name <- Fresh:22 typed league/club.go",
      "Club.Score <- Score:13 typed league/club.go",
      "Stats.Goals <- Club.Rename:7 typed league/club.go",
    ]);
  });

  it("keeps a namesake type of another package apart, and a type from a library package", () => {
    expect(rows().filter((r) => r.includes("garage/garage.go") && !r.includes("package"))).toEqual(["Club.Name <- Club.Rename:8 this garage/garage.go"]);
    expect((summary.fieldWrites ?? []).some((w) => w.function === "Score" && w.member === "Name" && w.line === 14)).toBe(false);
  });

  it("joins a bare assignment to the package variable a sibling file declares, and never to a local, a parameter or a result", () => {
    expect(rows().filter((r) => r.includes(" package "))).toEqual([
      "garage.clubCount <- Club.Rename:9 package garage/garage.go",
      "league.cache <- Score:15 package league/club.go",
      "league.clubCount <- Club.Rename:9 package league/club.go",
      "league.ready <- Fresh:23 package league/club.go",
    ]);
    expect((summary.fieldWrites ?? []).some((w) => w.file === "league/more.go" || w.file === "league/ops_test.go")).toBe(false);
  });
});

describe("member effects, two language families in one project", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-effects-mixed-"));
    await mkdir(join(dir, "web"), { recursive: true });
    await mkdir(join(dir, "server", "models"), { recursive: true });
    await writeFile(join(dir, "go.mod"), "module example.com/league\n\ngo 1.21\n");
    await writeFile(join(dir, "server", "models", "error.go"), "package models\n\ntype Error struct{ Code int }\n");
    await writeFile(join(dir, "web", "club.ts"), [
      "export function signPlayer(name: string) {",
      "  if (!name) throw new Error(\"no name\");",
      "  throw new ClubError(\"closed\");",
      "}",
      "",
    ].join("\n"));
    await writeFile(join(dir, "web", "errors.ts"), "export class ClubError extends Error {}\n");
    await writeFile(join(dir, "web", "package.json"), "{\"name\":\"web\"}\n");
    await mkdir(join(dir, "out"), { recursive: true });
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("never resolves a TypeScript throw to a Go type of that name, and still resolves a TypeScript project class", () => {
    const rows = (summary.thrownTypes ?? []).filter((t) => t.file === "web/club.ts");
    expect(rows.find((t) => t.type === "Error")?.classFile).toBeUndefined();
    expect(rows.find((t) => t.type === "ClubError")?.classFile).toBe("web/errors.ts");
  });
});

describe("member effects, Ruby", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-effects-rb-"));
    await mkdir(join(dir, "app", "models"), { recursive: true });
    await mkdir(join(dir, "app", "errors"), { recursive: true });
    await mkdir(join(dir, "app", "services"), { recursive: true });
    await writeFile(join(dir, "app", "errors", "errors.rb"), [
      "module League",
      "  class ClubNotFound < StandardError; end",
      "end",
    ].join("\n"));
    await writeFile(join(dir, "app", "models", "base.rb"), [
      "class Base",
      "  attr_writer :status",
      "  def initialize",
      "    @id = 0",
      "  end",
      "end",
    ].join("\n"));
    await writeFile(join(dir, "app", "models", "club.rb"), [
      "module League",
      "  class Club < Base",
      "    attr_accessor :name",
      "    attr_reader :budget",
      "    def initialize(name)",
      "      @name = name",
      "      @@count += 1",
      "    end",
      "    def win(extra)",
      "      @points += 1",
      "      @items[extra] = 1",
      "      self.name = \"w\"",
      "      self.status = \"on\"",
      "      @id = 2",
      "      @budget ||= compute",
      "      puts \"@ghost = 1\"",
      "      raise ClubNotFound, \"x\" if @points < 0",
      "      raise League::ClubNotFound.new(\"y\")",
      "      raise \"text\"",
      "      fail Unknown::Boom",
      "      raise",
      "    end",
      "    def self.reset",
      "      @count = 0",
      "    end",
      "  end",
      "end",
      "class Other",
      "  attr_accessor :name",
      "  def win; @name = 1; end",
      "end",
    ].join("\n"));
    await writeFile(join(dir, "app", "models", "notes.rb"), [
      "class Notes",
      "  def run",
      "    # @ghost = 1",
      "    # raise Phantom",
      "    text = <<~TXT",
      "      @inside = 1",
      "    TXT",
      "    @real = 1",
      "  end",
      "  class << self",
      "    def reset",
      "      @cache = nil",
      "    end",
      "  end",
      "end",
    ].join("\n"));
    await writeFile(join(dir, "app", "services", "garage.rb"), [
      "class Garage",
      "  attr_accessor :name",
      "  def rename(c, other)",
      "    c.name = \"z\"",
      "    other.name = \"q\"",
      "    free.name = \"n\"",
      "  end",
      "  # @param c [League::Club]",
      "  def tidy(c)",
      "    c.name = \"t\"",
      "  end",
      "end",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (): string[] => (summary.fieldWrites ?? []).map((w) => `${w.class}.${w.member} <- ${w.function}:${w.line} ${w.via} ${w.classFile}`).sort();

  it("lists instance-variable, class-variable and writer-method writes in the class that declares them", () => {
    expect(rows()).toEqual([
      "Base.status <- Club.win:13 this app/models/base.rb",
      "Club.@@count <- Club.initialize:7 this app/models/club.rb",
      "Club.budget <- Club.win:15 this app/models/club.rb",
      "Club.id <- Club.win:14 this app/models/club.rb",
      "Club.items <- Club.win:11 this app/models/club.rb",
      "Club.name <- Club.win:12 this app/models/club.rb",
      "Club.name <- Garage.tidy:10 typed app/models/club.rb",
      "Club.points <- Club.win:10 this app/models/club.rb",
      "Notes.real <- Notes.run:8 this app/models/notes.rb",
      "Other.name <- Other.win:30 this app/models/club.rb",
    ]);
  });

  it("states nothing for a constructor's own assignments, a class method, a string or an untyped receiver", () => {
    expect((summary.fieldWrites ?? []).some((w) => w.function === "Club.initialize" && w.member === "name")).toBe(false);
    expect((summary.fieldWrites ?? []).some((w) => w.function.endsWith(".reset") || w.member === "ghost" || w.member === "count")).toBe(false);
    expect(rows().filter((r) => r.includes("Garage.rename"))).toEqual([]);
  });

  it("lists raised constants as written, with the class they name, and no type for text or a bare raise", () => {
    expect((summary.thrownTypes ?? []).map((t) => `${t.type}:${t.line} ${t.classFile ?? "-"}`).sort()).toEqual([
      "ClubNotFound:17 app/errors/errors.rb",
      "League::ClubNotFound:18 app/errors/errors.rb",
      "Unknown::Boom:20 -",
    ]);
  });
});

describe("member effects, Rust", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-effects-rs-"));
    await mkdir(join(dir, "src", "models"), { recursive: true });
    await mkdir(join(dir, "src", "services"), { recursive: true });
    await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "league"\nversion = "0.1.0"\n');
    await writeFile(join(dir, "src", "models", "club.rs"), [
      "pub struct Stats { pub goals: u32 }",
      "pub struct Club {",
      "    pub name: String,",
      "    pub points: u32,",
      "    pub stats: Stats,",
      "    pub items: Vec<u32>,",
      "}",
      "impl Club {",
      "    pub fn win(&mut self, n: u32) {",
      "        let old = self.points;",
      "        self.points += 3;",
      "        self.stats.goals += n;",
      "        self.items[0] = 1;",
      "        self.name = format!(\"self.ghost = 1\");",
      "        if old == self.points { self.items.push(1); }",
      "        // self.points = 9;",
      "        *self.counter += 1;",
      "    }",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "src", "models", "extra.rs"), [
      "use crate::models::club::Club;",
      "impl Club {",
      "    pub fn reset(&mut self) {",
      "        self.points = 0;",
      "    }",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "src", "services", "garage.rs"), [
      "use crate::models::club::Club;",
      "static mut TOTAL: u32 = 0;",
      "pub struct Club2 { pub name: String }",
      "pub fn rename(club: &mut Club, other: &Club2, plain: &Club) {",
      "    club.name = String::new();",
      "    let mut local: Club2 = make();",
      "    local.name = String::new();",
      "    unsafe { TOTAL += 1; }",
      "}",
      "pub fn score(s: &mut crate::models::club::Stats) {",
      "    s.goals = 1;",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "src", "services", "club.rs"), [
      "pub struct Club { pub name: String }",
      "impl Club {",
      "    pub fn call(&mut self) { self.name = String::new(); }",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (): string[] => (summary.fieldWrites ?? []).map((w) => `${w.class}.${w.member} <- ${w.function}:${w.line} ${w.via} ${w.classFile}`).sort();

  it("lists writes through self, a field's struct, a typed parameter and a typed local, in the struct that declares them", () => {
    expect(rows().filter((r) => !r.includes("TOTAL"))).toEqual([
      "Club.name <- Club.call:3 this src/services/club.rs",
      "Club.points <- Club.reset:4 this src/models/club.rs",
      "Club.points <- Club.win:11 this src/models/club.rs",
      "Club.items <- Club.win:13 this src/models/club.rs",
      "Club.name <- Club.win:14 this src/models/club.rs",
      "Club2.name <- rename:7 typed src/services/garage.rs",
      "Stats.goals <- Club.win:12 typed src/models/club.rs",
      "Stats.goals <- score:11 typed src/models/club.rs",
    ].sort());
  });

  it("states nothing for a let, a comment, a string, a deref or a mutating call", () => {
    expect((summary.fieldWrites ?? []).some((w) => w.function === "Club.win" && (w.line === 10 || w.line === 15 || w.line === 16 || w.line === 17))).toBe(false);
  });

  it("joins a static mut written bare to the file that declares it, and never lists a thrown type", () => {
    expect(rows().filter((r) => r.includes("TOTAL"))).toEqual(["garage.TOTAL <- rename:8 package src/services/garage.rs"]);
    expect((summary.thrownTypes ?? []).length).toBe(0);
  });
});

describe("member effects, Dart", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-effects-dart-"));
    await mkdir(join(dir, "lib", "models"), { recursive: true });
    await mkdir(join(dir, "lib", "services"), { recursive: true });
    await writeFile(join(dir, "pubspec.yaml"), "name: league\n");
    await writeFile(join(dir, "lib", "models", "club.dart"), [
      "class Stats {",
      "  int goals = 0;",
      "}",
      "class ClubClosed implements Exception {}",
      "class Club {",
      "  String name;",
      "  int points = 0;",
      "  int _visits = 0;",
      "  Stats stats = Stats();",
      "  Club(this.name) { points = 1; }",
      "  Club.guest()",
      "      : name = 'Guest',",
      "        points = 0;",
      "  void win(int n) {",
      "    final old = points;",
      "    this.points += 3;",
      "    this.stats.goals = n;",
      "    _visits++;",
      "    name = 'this.ghost = 1';",
      "    // points = 9;",
      "    var points2 = 0;",
      "    points2 = 4;",
      "    if (old == points) throw ClubClosed();",
      "  }",
      "  void close() {",
      "    try { win(1); } catch (e) { rethrow; }",
      "    throw StateError('closed');",
      "  }",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "lib", "services", "garage.dart"), [
      "import '../models/club.dart';",
      "void rename(Club club, Stats stats) {",
      "  club.name = 'Rovers';",
      "  stats.goals += 1;",
      "  final Club other = Club('x');",
      "  other.points = 2;",
      "  final plain = 3;",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (): string[] => (summary.fieldWrites ?? []).map((w) => `${w.class}.${w.member} <- ${w.function}:${w.line} ${w.via}`).sort();

  it("lists writes through this, a field's object, a bare field and a typed parameter or local, never from a constructor", () => {
    expect(rows()).toEqual([
      "Club._visits <- Club.win:18 this",
      "Club.name <- Club.win:19 this",
      "Club.name <- rename:3 typed",
      "Club.points <- Club.win:16 this",
      "Club.points <- rename:6 typed",
      "Stats.goals <- Club.win:17 typed",
      "Stats.goals <- rename:4 typed",
    ].sort());
  });

  it("lists the project exception a method throws, never a rethrow", () => {
    const thrown = (summary.thrownTypes ?? []).map((t) => `${t.type} <- ${t.function}:${t.line}`).sort();
    expect(thrown).toContain("ClubClosed <- Club.win:23");
    expect(thrown.some((t) => t.includes(":26"))).toBe(false);
  });
});

describe("member effects, Swift", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-effects-swift-"));
    await mkdir(join(dir, "Sources", "League", "Models"), { recursive: true });
    await mkdir(join(dir, "Sources", "League", "Services"), { recursive: true });
    await writeFile(join(dir, "Package.swift"), "// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: \"League\")\n");
    await writeFile(join(dir, "Sources", "League", "Models", "Club.swift"), [
      "struct Stats {",
      "    var goals: Int = 0",
      "}",
      "enum ClubError: Error {",
      "    case closed",
      "}",
      "struct ClubClosed: Error {}",
      "final class Club {",
      "    var name: String",
      "    var points: Int = 0",
      "    private var visits = 0",
      "    var stats = Stats()",
      "    init(name: String) {",
      "        self.name = name",
      "        points = 1",
      "    }",
      "    func win(_ n: Int) throws {",
      "        let old = points",
      "        self.points += 3",
      "        self.stats.goals = n",
      "        visits += 1",
      "        name = \"self.ghost = 1\"",
      "        // points = 9",
      "        var points2 = 0",
      "        points2 = 4",
      "        if old == points { throw ClubError.closed }",
      "        if n < 0 { throw ClubClosed() }",
      "    }",
      "    func close() throws(ClubError) {",
      "        do { try win(1) } catch { throw error }",
      "        let reset = { [weak self] in self?.points = 0 }",
      "        reset()",
      "    }",
      "    func shadow() {",
      "        var name = \"local\"",
      "        name = \"other\"",
      "    }",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "Sources", "League", "Models", "Club+Season.swift"), [
      "extension Club {",
      "    func relegate() {",
      "        points = 0",
      "        ghost = 1",
      "    }",
      "    func fail() throws { throw ClubError.Closed }",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "Sources", "League", "Services", "Garage.swift"), [
      "func rename(club: Club, stats: inout Stats) {",
      "    club.name = \"Rovers\"",
      "    stats.goals += 1",
      "    let other: Club = Club(name: \"x\")",
      "    other.points = 2",
      "    let plain = 3",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (): string[] => (summary.fieldWrites ?? []).map((w) => `${w.class}.${w.member} <- ${w.function}:${w.line} ${w.via}`).sort();

  it("lists writes through self, a member's object, a bare member, an extension and a typed parameter or local, never from init", () => {
    expect(rows()).toEqual([
      "Club.name <- Club.win:22 this",
      "Club.name <- rename:2 typed",
      "Club.points <- Club.close:31 this",
      "Club.points <- Club.relegate:3 this",
      "Club.points <- Club.win:19 this",
      "Club.points <- rename:5 typed",
      "Club.visits <- Club.win:21 this",
      "Stats.goals <- Club.win:20 typed",
      "Stats.goals <- rename:3 typed",
    ].sort());
  });

  it("lists the type after throw and a signature's typed throws, never a rethrown error", () => {
    const thrown = (summary.thrownTypes ?? []).map((t) => `${t.type} <- ${t.function}:${t.line}${t.declared ? " declared" : ""}`).sort();
    expect(thrown).toEqual(["ClubClosed <- Club.win:27", "ClubError <- Club.close:29 declared", "ClubError <- Club.fail:6", "ClubError <- Club.win:26"]);
  });
});

describe("member effects, Scala", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-member-effects-scala-"));
    await mkdir(join(dir, "src", "main", "scala", "league", "models"), { recursive: true });
    await mkdir(join(dir, "src", "main", "scala", "league", "services"), { recursive: true });
    await writeFile(join(dir, "build.sbt"), 'name := "league"\n');
    await writeFile(join(dir, "src", "main", "scala", "league", "models", "Club.scala"), [
      "package league.models",
      "",
      "class Stats {",
      "  var goals: Int = 0",
      "}",
      "class ClubClosed(msg: String) extends RuntimeException(msg)",
      "case class Missing(id: Long) extends Exception",
      "class Club(var name: String) {",
      "  var points: Int = 0",
      "  private var visits = 0",
      "  val stats = new Stats()",
      "  def this() = {",
      "    this(\"Guest\")",
      "    points = 1",
      "  }",
      "  @throws[ClubClosed]",
      "  def win(n: Int): Unit = {",
      "    val old = points",
      "    this.points += 3",
      "    this.stats.goals = n",
      "    visits += 1",
      "    name = \"this.ghost = 1\"",
      "    // points = 9",
      "    var points2 = 0",
      "    points2 = 4",
      "    if (old == points) throw new ClubClosed(\"closed\")",
      "    if (n < 0) throw Missing(n)",
      "  }",
      "  def rename(n: String): Club = copy(",
      "    name = n,",
      "  )",
      "  def copy(name: String): Club = new Club(name)",
      "  def close(): Unit = {",
      "    try win(1) catch { case e: Exception => throw e }",
      "    List(1, 2).foreach { points => println(points) }",
      "  }",
      "}",
      "object Registry {",
      "  var count = 0",
      "  def bump(): Unit = { count += 1 }",
      "}",
    ].join("\n"));
    await writeFile(join(dir, "src", "main", "scala", "league", "services", "Garage.scala"), [
      "package league.services",
      "",
      "import league.models.{Club, Stats}",
      "",
      "object Garage {",
      "  def rename(club: Club, stats: Stats): Unit = {",
      "    club.name = \"Rovers\"",
      "    stats.goals += 1",
      "    val other: Club = new Club(\"x\")",
      "    other.points = 2",
      "    val plain = 3",
      "  }",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (): string[] => (summary.fieldWrites ?? []).map((w) => `${w.class}.${w.member} <- ${w.function}:${w.line} ${w.via}`).sort();

  it("lists writes through this, a member's object, a bare var and a typed parameter or local, never a named argument or an auxiliary constructor", () => {
    expect(rows()).toEqual([
      "Club.name <- Club.win:22 this",
      "Club.name <- Garage.rename:7 typed",
      "Club.points <- Club.win:19 this",
      "Club.points <- Garage.rename:10 typed",
      "Club.visits <- Club.win:21 this",
      "Registry.count <- Registry.bump:40 this",
      "Stats.goals <- Club.win:20 typed",
      "Stats.goals <- Garage.rename:8 typed",
    ].sort());
  });

  it("lists the type after throw and a @throws annotation, never a rethrown exception", () => {
    const thrown = (summary.thrownTypes ?? []).map((t) => `${t.type} <- ${t.function}:${t.line}${t.declared ? " declared" : ""}`).sort();
    expect(thrown).toEqual(["ClubClosed <- Club.win:16 declared", "ClubClosed <- Club.win:26", "Missing <- Club.win:27"]);
  });
});
