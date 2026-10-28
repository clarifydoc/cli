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
