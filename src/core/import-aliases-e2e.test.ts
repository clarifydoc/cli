import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A name an import binds under another name (`from m import f as g`, `use X as Y`,
 * `import { Engine as Motor }`, `import a.B as C`, `import m.{Club => Team}`,
 * `use crate::car::Car as Motor`) means the module's own definition — never a
 * namesake of the alias elsewhere, which every project below also declares.
 */
const FILES: Record<string, string> = {
  // Python
  "py/league/__init__.py": "",
  "py/league/scoring/__init__.py": "",
  "py/league/goals.py": "def score_goal(minute):\n    return minute\n\n\ndef own_goal(minute):\n    return -minute\n",
  "py/league/scoring/tally.py": "def add_points(club, points):\n    return points\n",
  "py/legacy/__init__.py": "",
  "py/legacy/decoys.py": "def score_goal(m):\n    return 0\n\n\ndef sg(m):\n    return 0\n\n\ndef og(m):\n    return 0\n\n\ndef add_points(c, p):\n    return 0\n",
  "py/league/match.py": [
    "from league.goals import score_goal as sg",
    "from .goals import own_goal as og",
    "from league.scoring import tally as t",
    "",
    "",
    "def play():",
    "    sg(1)",
    "    og(2)",
    "    t.add_points('club', 3)",
  ].join("\n"),
  // PHP
  "php/composer.json": JSON.stringify({ name: "league/app", require: { "laravel/framework": "^10.0" }, autoload: { "psr-4": { "App\\": "app/" } } }),
  "php/app/Models/Player.php": "<?php\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Player extends Model\n{\n    protected $table = 'players';\n\n    public function train()\n    {\n        return $this;\n    }\n}\n",
  "php/app/Legacy/Footballer.php": "<?php\nnamespace App\\Legacy;\n\nclass Footballer\n{\n    public static function find($id)\n    {\n        return null;\n    }\n}\n",
  "php/app/Garage/Bay.php": "<?php\nnamespace App\\Garage;\n\nclass Bay\n{\n    public function park()\n    {\n        return 1;\n    }\n}\n",
  "php/app/Fleet/Bay.php": "<?php\nnamespace App\\Fleet;\n\nclass Bay\n{\n    public function park()\n    {\n        return 2;\n    }\n}\n",
  "php/app/Http/ClubController.php": "<?php\nnamespace App\\Http;\n\nclass ClubController\n{\n    public static function listAll()\n    {\n        return [];\n    }\n}\n",
  "php/app/Legacy/Clubs.php": "<?php\nnamespace App\\Legacy;\n\nclass Clubs\n{\n    public static function listAll()\n    {\n        return null;\n    }\n}\n",
  "php/app/Http/SquadController.php": [
    "<?php",
    "namespace App\\Http;",
    "",
    "use App\\Models\\Player as Footballer;",
    "use App\\Fleet\\Bay as FleetBay;",
    "use App\\Http\\{ClubController as Clubs};",
    "",
    "class SquadController",
    "{",
    "    public function index()",
    "    {",
    "        $p = Footballer::find(1);",
    "        $f = new Footballer();",
    "        $bay = new FleetBay();",
    "        $bay->park();",
    "        return Clubs::listAll();",
    "    }",
    "}",
  ].join("\n"),
  // TypeScript
  "ts/package.json": JSON.stringify({ name: "garage", dependencies: { typescript: "5.0.0" } }),
  "ts/src/engine.ts": "export class Engine {\n  start(): number {\n    return 1;\n  }\n}\n",
  "ts/src/lathe.ts": "export default class Lathe {\n  spin(): number {\n    return 2;\n  }\n}\n",
  "ts/src/legacy/motor.ts": "export class Motor {\n  start(): number {\n    return 0;\n  }\n}\nexport class Machine {\n  spin(): number {\n    return 0;\n  }\n}\n",
  "ts/src/garage.ts": [
    'import { Engine as Motor } from "./engine";',
    'import Machine from "./lathe";',
    "export class Turbo extends Motor {",
    "  boost(): number {",
    "    return this.start();",
    "  }",
    "}",
    "export function service(m: Motor): number {",
    "  return m.start();",
    "}",
    "export class Garage {",
    "  private motor: Motor;",
    "  constructor(private spare: Motor) {",
    "    this.motor = this.spare;",
    "  }",
    "  run(): number {",
    "    this.spare.start();",
    "    return this.motor.start();",
    "  }",
    "  turn(): number {",
    "    const lathe = new Machine();",
    "    return lathe.spin();",
    "  }",
    "}",
  ].join("\n"),
  // Kotlin
  "kt/build.gradle.kts": 'plugins { kotlin("jvm") version "1.9.0" }\n',
  "kt/src/main/kotlin/garage/Mechanic.kt": "package garage\n\nclass Mechanic {\n    fun repair(): Int = 1\n}\n",
  "kt/src/main/kotlin/fleet/Fixer.kt": "package fleet\n\nclass Fixer {\n    fun repair(): Int = 0\n}\n",
  "kt/src/main/kotlin/app/Workshop.kt": "package app\n\nimport garage.Mechanic as Fixer\n\nclass Workshop {\n    fun open(): Int {\n        val f: Fixer = Fixer()\n        return f.repair()\n    }\n}\n",
  // Scala
  "scala/build.sbt": 'scalaVersion := "3.3.0"\n',
  "scala/src/main/scala/league/model/Club.scala": "package league.model\n\nclass Club(val name: String) {\n  def play(): Int = 1\n}\n\nobject Club {\n  def founded(name: String): Club = new Club(name)\n}\n",
  "scala/src/main/scala/league/legacy/Team.scala": "package league.legacy\n\nclass Team(val name: String) {\n  def play(): Int = 0\n}\n\nobject Team {\n  def founded(name: String): Team = new Team(name)\n}\n",
  "scala/src/main/scala/league/app/Season.scala": "package league.app\n\nimport league.model.{Club => Team}\n\nclass Season {\n  def start(): Int = {\n    val t = new Team(\"Rovers\")\n    Team.founded(\"United\")\n    t.play()\n  }\n}\n",
  // Rust
  "rs/Cargo.toml": '[package]\nname = "garage"\nversion = "0.1.0"\nedition = "2021"\n',
  "rs/src/main.rs": "mod garage;\nmod fleet;\n\nuse crate::garage::car::Car as Motor;\n\nfn main() {\n    let m = Motor::new();\n    m.drive();\n}\n",
  "rs/src/garage/mod.rs": "pub mod car;\n",
  "rs/src/garage/car.rs": "pub struct Car {\n    pub speed: u32,\n}\n\nimpl Car {\n    pub fn new() -> Car {\n        Car { speed: 0 }\n    }\n\n    pub fn drive(&self) -> u32 {\n        self.speed\n    }\n}\n",
  "rs/src/fleet/mod.rs": "pub struct Motor {\n    pub rpm: u32,\n}\n\nimpl Motor {\n    pub fn new() -> Motor {\n        Motor { rpm: 0 }\n    }\n\n    pub fn drive(&self) -> u32 {\n        self.rpm\n    }\n}\n",
};

describe("import aliases, end to end", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-aliases-"));
    const root = join(dir, "league");
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const targets = (file: string, symbol: string): string[] =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === file && l.sourceSymbol === symbol && l.sourceSymbol !== "(reference)")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();

  it("Python: a renamed function, relative too, and a renamed module", () => {
    expect(targets("py/league/match.py", "play")).toEqual([
      "og -> py/league/goals.py::own_goal",
      "sg -> py/league/goals.py::score_goal",
      "t.add_points -> py/league/scoring/tally.py::add_points",
    ]);
  });

  it("PHP: a renamed class called statically, constructed and typed, grouped too", () => {
    expect(targets("php/app/Http/SquadController.php", "SquadController.index")).toEqual([
      "Clubs.listAll -> php/app/Http/ClubController.php::ClubController.listAll",
      "bay.park -> php/app/Fleet/Bay.php::Bay.park",
      "new FleetBay -> php/app/Fleet/Bay.php::Bay",
      "new Footballer -> php/app/Models/Player.php::Player",
    ]);
    // `Footballer::find` is the Eloquent model's read, not the legacy class's method.
    const access = (summary.symbolDataAccess ?? []).find((s) => s.symbol === "SquadController.index");
    expect(access?.entity).toBe("Player");
  });

  it("TypeScript: a renamed class as a base, a parameter and a field type, and a default import", () => {
    expect(targets("ts/src/garage.ts", "Turbo.boost")).toEqual(["this.start -> ts/src/engine.ts::Engine.start"]);
    expect(targets("ts/src/garage.ts", "service")).toEqual(["m.start -> ts/src/engine.ts::Engine.start"]);
    expect(targets("ts/src/garage.ts", "Garage.run")).toEqual([
      "this.motor.start -> ts/src/engine.ts::Engine.start",
      "this.spare.start -> ts/src/engine.ts::Engine.start",
    ]);
    expect(targets("ts/src/garage.ts", "Garage.turn")).toEqual([
      "Machine -> ts/src/lathe.ts::Lathe",
      "lathe.spin -> ts/src/lathe.ts::Lathe.spin",
    ]);
  });

  it("Kotlin: a renamed class constructed and typed", () => {
    expect(targets("kt/src/main/kotlin/app/Workshop.kt", "Workshop.open")).toEqual([
      "Fixer -> kt/src/main/kotlin/garage/Mechanic.kt::Mechanic",
      "f.repair -> kt/src/main/kotlin/garage/Mechanic.kt::Mechanic.repair",
    ]);
  });

  it("Scala: a renamed class constructed, its companion called, an instance typed", () => {
    expect(targets("scala/src/main/scala/league/app/Season.scala", "Season.start")).toEqual([
      "Team -> scala/src/main/scala/league/model/Club.scala::Club",
      "Team.founded -> scala/src/main/scala/league/model/Club.scala::Club.founded",
      "t.play -> scala/src/main/scala/league/model/Club.scala::Club.play",
    ]);
  });

  it("Rust: a renamed struct's associated function and an instance's method", () => {
    expect(targets("rs/src/main.rs", "main")).toEqual([
      "Motor.new -> rs/src/garage/car.rs::Car.new",
      "m.drive -> rs/src/garage/car.rs::Car.drive",
    ]);
  });
});
