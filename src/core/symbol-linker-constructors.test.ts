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

describe("C# accessors and chained constructors link", () => {
  it("links accessor calls from the property and `this(…)`/`base(…)` to the overload the arguments choose", async () => {
    const analyses = await analyzeAll({
      "League/Club.cs": [
        "namespace League",
        "{",
        "    public class Club",
        "    {",
        "        public Club(string name) {}",
        "        public Club(string name, int rank) : this(name) {}",
        "        public int Total { get { return Tally(); } }",
        "        private int Tally() { return 1; }",
        "    }",
        "",
        "    public class Giants : Club",
        "    {",
        "        public Giants(string n) : base(n, 1) {}",
        "    }",
        "}",
        "",
      ].join("\n"),
    }, "csharp");
    const links = buildSymbolLinks(analyses).filter((l) => l.sourceSymbol !== "(reference)");
    const from = (sym: string) => links.filter((l) => l.sourceSymbol === sym).map((l) => `${l.callName} -> ${l.targetSymbol}@${l.targetLine} [${l.strategy}]`);
    expect(from("Club.Total")).toEqual(["Tally -> Club.Tally@8 [direct]"]);
    expect(from("Club.Club")).toEqual(expect.arrayContaining(["new Club -> Club.Club@5 [constructor]"]));
    expect(from("Giants.Giants")).toEqual(["new Club -> Club.Club@6 [constructor]"]);
  });
});

describe("construction without a written constructor call", () => {
  const relations = (analyses: FileAnalysis[], from: string) =>
    buildSymbolLinks(analyses)
      .filter((l) => l.sourceFile === from && l.relation === "instantiates")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();

  it("Java: `new Club()` with no declared constructor reaches the same-package class, never a namesake", async () => {
    const analyses = await analyzeAll({
      "com/example/league/Club.java": "package com.example.league;\npublic class Club { public String name; }\n",
      "com/example/other/Club.java": "package com.example.other;\npublic class Club { public Club(int x) {} }\n",
      "com/example/league/Main.java": "package com.example.league;\npublic class Main { void run() { Club c = new Club(); } }\n",
    }, "java");
    expect(relations(analyses, "com/example/league/Main.java")).toEqual(["new Club -> com/example/league/Club.java::Club"]);
  });

  it("Java: `super(...)` and `this(...)` reach the constructor the language runs", async () => {
    const analyses = await analyzeAll({
      "com/example/league/Base.java": "package com.example.league;\npublic class Base { public Base(String n) {} }\n",
      "com/example/other/Base.java": "package com.example.other;\npublic class Base { public Base(String n) {} }\n",
      "com/example/league/Derived.java": [
        "package com.example.league;",
        "public class Derived extends Base {",
        "  public Derived() { this(\"x\"); }",
        "  public Derived(String s) { super(s); }",
        "}",
        "",
      ].join("\n"),
    }, "java");
    expect(relations(analyses, "com/example/league/Derived.java")).toEqual([
      "new Base -> com/example/league/Base.java::Base.Base",
      "new Derived -> com/example/league/Derived.java::Derived.Derived",
    ]);
  });

  it("Go: a composite literal constructs its struct; a namesake package and a slice literal link nothing", async () => {
    const analyses = await analyzeAll({
      "models/club.go": "package models\ntype Club struct { Name string }\nfunc New() Club { return Club{} }\n",
      "other/club.go": "package other\ntype Club struct { ID int }\n",
      "svc/svc.go": "package svc\nimport \"example.com/league/models\"\nfunc Make() *models.Club { c := &models.Club{Name: \"x\"}; s := []string{\"a\"}; _ = s; return c }\n",
    }, "go");
    expect(relations(analyses, "svc/svc.go")).toEqual(["models.Club -> models/club.go::Club"]);
  });

  it("Rust: a struct expression constructs its struct, not `Club::new`; a match pattern constructs nothing", async () => {
    const analyses = await analyzeAll({
      "src/models.rs": "pub struct Club { pub name: String }\nimpl Club {\n    pub fn new() -> Club { Club { name: String::new() } }\n}\n",
      "src/other.rs": "pub struct Club { pub id: u32 }\n",
      "src/main.rs": "mod models;\nmod other;\nmod svc;\nfn main() {}\n",
      "src/svc.rs": "use crate::models::Club;\npub fn make() -> Club { let c = Club { name: String::from(\"x\") }; c }\npub fn check(c: Club) -> bool { match c { Club { name } => name.is_empty() } }\n",
    }, "rust");
    expect(relations(analyses, "src/svc.rs")).toEqual(["Club -> src/models.rs::Club"]);
  });
});

describe("struct literals of foreign or non-literal shape", () => {
  it("Go: `http.Client{}` never reaches a project `Client`; `a && b {` and a rune holding a quote are read right", async () => {
    const analyses = await analyzeAll({
      "net/client.go": "package net\ntype Client struct { ID int }\ntype Garage struct { Cars int }\n",
      "svc/svc.go": [
        "package svc",
        "import \"net/http\"",
        "func Make(ok bool, Garage bool) {",
        "  c := http.Client{}",
        "  if ok && Garage {",
        "  }",
        "  q := '\"'; _ = q; _ = c",
        "}",
        "",
      ].join("\n"),
    }, "go");
    expect(buildSymbolLinks(analyses).filter((l) => l.relation === "instantiates")).toEqual([]);
  });
});
