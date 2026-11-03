/**
 * A call constructing a class reaches the constructor its arguments choose:
 * Kotlin secondary constructors (all named `constructor`), Java and C#
 * class-named ones, and a class built in the file that declares it. Through
 * the real per-file pipeline, then the linker.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis, Language } from "../types/analysis.js";

async function analyzeAll(files: Record<string, string>, language: Language): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "ctor-overloads-"));
  const out = await mkdtemp(join(tmpdir(), "ctor-overloads-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

/** Each call `from` makes, as `line callName -> file::symbol@line [strategy]`. */
function callsFrom(analyses: FileAnalysis[], from: string): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.sourceFile === from && l.sourceSymbol !== "(reference)")
    .map((l) => `${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}@${l.targetLine} [${l.strategy}]`)
    .sort();
}

const kotlinClub = [
  "package league",
  "",
  "class Club(val name: String) {",
  "    constructor(id: Int) : this(id.toString())",
  "    constructor(name: String, founded: Int) : this(name)",
  "}",
  "",
].join("\n");

describe("constructor overloads", () => {
  it("Kotlin: a call naming the class reaches the primary or secondary constructor its arguments fit", async () => {
    const analyses = await analyzeAll({
      "league/Club.kt": kotlinClub,
      "league/Main.kt": [
        "package league",
        "",
        "fun main() {",
        "    val a = Club(\"Rovers\")",
        "    val b = Club(3)",
        "    val c = Club(\"United\", 1900)",
        "}",
        "",
      ].join("\n"),
    }, "kotlin");
    expect(callsFrom(analyses, "league/Main.kt")).toEqual([
      "4 Club -> league/Club.kt::Club.constructor@3 [constructor]",
      "5 Club -> league/Club.kt::Club.constructor@4 [constructor]",
      "6 Club -> league/Club.kt::Club.constructor@5 [constructor]",
    ]);
  });

  it("Kotlin: in the file declaring the class, the call reaches the chosen constructor, not the class", async () => {
    const analyses = await analyzeAll({
      "league/Club.kt": `${kotlinClub}\nclass Cup {\n    fun draw() {\n        val c = Club(3)\n        val d = Club("Town")\n    }\n}\n`,
    }, "kotlin");
    expect(callsFrom(analyses, "league/Club.kt")).toEqual([
      "10 Club -> league/Club.kt::Club.constructor@4 [constructor]",
      "11 Club -> league/Club.kt::Club.constructor@3 [constructor]",
    ]);
  });

  it("Java: `new Garage(…)` in the file declaring it reaches the class-named constructor its arguments fit", async () => {
    const analyses = await analyzeAll({
      "garage/Garage.java": [
        "package garage;",
        "",
        "public class Garage {",
        "    public Garage(String name) {}",
        "    public Garage(int bays) {}",
        "",
        "    static Garage open() {",
        "        return new Garage(3);",
        "    }",
        "}",
        "",
        "class Car {",
        "    void park() {",
        "        Garage g = new Garage(\"West\");",
        "    }",
        "}",
        "",
      ].join("\n"),
    }, "java");
    expect(callsFrom(analyses, "garage/Garage.java")).toEqual([
      "14 new Garage -> garage/Garage.java::Garage.Garage@4 [constructor]",
      "8 new Garage -> garage/Garage.java::Garage.Garage@5 [constructor]",
    ]);
  });

  it("C#: `new Garage(…)` beside the class reaches the constructor its arguments fit, and a class without one", async () => {
    const analyses = await analyzeAll({
      "Cars/Garage.cs": [
        "namespace Cars",
        "{",
        "    public class Garage",
        "    {",
        "        public Garage(string name) {}",
        "        public Garage(int bays) {}",
        "    }",
        "",
        "    public class Tyre {}",
        "",
        "    public class Fitter",
        "    {",
        "        public void Run()",
        "        {",
        "            var a = new Garage(\"North\");",
        "            var b = new Garage(4);",
        "            var t = new Tyre();",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
    }, "csharp");
    expect(callsFrom(analyses, "Cars/Garage.cs")).toEqual([
      "15 new Garage -> Cars/Garage.cs::Garage.Garage@5 [constructor]",
      "16 new Garage -> Cars/Garage.cs::Garage.Garage@6 [constructor]",
      "17 new Tyre -> Cars/Garage.cs::Tyre@9 [constructor]",
    ]);
  });
});

describe("construction reaches the constructor the class itself declares", () => {
  /** Each call `from` makes, as `line callName -> file::symbol [strategy/relation]`. */
  function made(analyses: FileAnalysis[], from: string): string[] {
    return buildSymbolLinks(analyses)
      .filter((l) => l.sourceFile === from && l.sourceSymbol !== "(reference)")
      .map((l) => `${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol} [${l.strategy}/${l.relation}]`)
      .sort();
  }

  it("Python: an imported or same-file class called by name reaches its own __init__, never a base's", async () => {
    const analyses = await analyzeAll({
      "league/models.py": [
        "class Model:",
        "    def __init__(self, **kw):",
        "        self.kw = kw",
        "",
        "class Player(Model):",
        "    def __init__(self, name, number):",
        "        super().__init__(name=name)",
        "",
        "class Coach(Model):",
        "    pass",
        "",
      ].join("\n"),
      "league/squad.py": [
        "from league.models import Player, Coach",
        "",
        "class Kit:",
        "    def __init__(self, colour):",
        "        self.colour = colour",
        "",
        "def pick_squad():",
        "    p = Player(\"Nine\", 9)",
        "    c = Coach(name=\"Boss\")",
        "    k = Kit(\"red\")",
        "    return [p, c, k]",
        "",
      ].join("\n"),
    }, "python");
    expect(made(analyses, "league/squad.py")).toEqual([
      "10 Kit -> league/squad.py::Kit.__init__ [constructor/instantiates]",
      "8 Player -> league/models.py::Player.__init__ [constructor/instantiates]",
      // No constructor of its own: the class, never `Model.__init__`.
      "9 Coach -> league/models.py::Coach [direct/calls]",
    ]);
  });

  it("TypeScript: `new X(…)` imported or beside the class reaches its own constructor; a JSX element stays on the class", async () => {
    const analyses = await analyzeAll({
      "src/models.tsx": [
        "export class Base { constructor(public id: string) {} }",
        "export class Player extends Base {",
        "  constructor(public name: string, public shirt: number) { super(name); }",
        "}",
        "export class Coach extends Base {}",
        "export class Board { constructor(props: object) {} render() { return null; } }",
        "",
      ].join("\n"),
      "src/squad.tsx": [
        "import { Player, Coach, Board } from \"./models\";",
        "class Kit { constructor(public colour: string) {} }",
        "export function pickSquad() {",
        "  const p = new Player(\"Nine\", 9);",
        "  const c = new Coach(\"Boss\");",
        "  const k = new Kit(\"red\");",
        "  return <Board />;",
        "}",
        "",
      ].join("\n"),
    }, "typescript");
    expect(made(analyses, "src/squad.tsx")).toEqual([
      "4 Player -> src/models.tsx::Player.constructor [constructor/instantiates]",
      "5 Coach -> src/models.tsx::Coach [direct/calls]",
      "6 Kit -> src/squad.tsx::Kit.constructor [constructor/instantiates]",
      "7 Board -> src/models.tsx::Board [direct/calls]",
    ]);
  });

  it("Rust: a tuple struct built by name never reaches its `new` function", async () => {
    const analyses = await analyzeAll({
      "src/score.rs": [
        "pub struct Score(pub u32);",
        "impl Score {",
        "    pub fn new(v: u32) -> Self { Score(v) }",
        "}",
        "pub fn opening() -> Score {",
        "    Score(0)",
        "}",
        "",
      ].join("\n"),
    }, "rust");
    expect(made(analyses, "src/score.rs").filter((l) => l.includes(" Score -> "))).toEqual([
      "3 Score -> src/score.rs::Score [direct/calls]",
      "6 Score -> src/score.rs::Score [direct/calls]",
    ]);
  });

  it("Swift: a call naming the class reaches its own `init`", async () => {
    const analyses = await analyzeAll({
      "Sources/League/Models.swift": [
        "class Person {",
        "    init(name: String) {}",
        "}",
        "class Player: Person {",
        "    init(name: String, number: Int) { super.init(name: name) }",
        "}",
        "class Coach: Person {}",
        "",
      ].join("\n"),
      "Sources/League/Squad.swift": [
        "func pick() {",
        "    let p = Player(name: \"Nine\", number: 9)",
        "    let c = Coach(name: \"Boss\")",
        "}",
        "",
      ].join("\n"),
    }, "swift");
    expect(made(analyses, "Sources/League/Squad.swift")).toEqual([
      "2 Player -> Sources/League/Models.swift::Player.init [constructor/instantiates]",
      "3 Coach -> Sources/League/Models.swift::Coach [constructor/instantiates]",
    ]);
  });
});
