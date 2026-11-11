/**
 * Kotlin constructor delegation (`class Derived(x: Int) : Base(x)`, `constructor(…) : this(…)` / `: super(…)`)
 * and Java anonymous classes (`new Base() { … }`), through the real per-file pipeline and the linker.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis, Language } from "../types/analysis.js";

async function analyzeAll(files: Record<string, string>, language: Language): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "jvm-ctors-"));
  const out = await mkdtemp(join(tmpdir(), "jvm-ctors-out-"));
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

/** What each symbol of `file` calls, as `source: line callName -> file::symbol@line [relation]`. */
function linksFrom(analyses: FileAnalysis[], file: string): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.sourceFile === file && l.sourceSymbol !== "(reference)")
    .map((l) => `${l.sourceSymbol}: ${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}@${l.targetLine} [${l.relation}]`)
    .sort();
}

describe("Kotlin constructor delegation", () => {
  const files = {
    "league/Base.kt": ["package league", "", "open class Base(val n: String) {", "    constructor(id: Int) : this(id.toString())", "}", ""].join("\n"),
    "other/Base.kt": ["package other", "", "open class Base(val n: String)", ""].join("\n"),
    "league/Derived.kt": [
      "package league",
      "",
      "class Derived(x: Int) : Base(x) {",
      "    constructor(s: String) : this(s.length)",
      "    constructor(a: String, b: Int) : this(a)",
      "}",
      "",
      "class Plain(val tag: String) : Base(tag)",
      "",
      "class Quiet : Base(\"q\")",
      "",
    ].join("\n"),
    "league/Kid.kt": [
      "package league",
      "",
      "open class Parent(val n: String) {",
      "    constructor(id: Int) : this(id.toString())",
      "}",
      "",
      "class Kid : Parent {",
      "    constructor(a: Int) : super(a)",
      "    constructor(s: String) : super(s)",
      "}",
      "",
    ].join("\n"),
  };

  it("a primary constructor runs the superclass constructor its arguments fit, never a namesake package's", async () => {
    const analyses = await analyzeAll(files, "kotlin");
    expect(linksFrom(analyses, "league/Derived.kt").filter((l) => l.includes("Base"))).toEqual([
      "Derived.constructor: 3 new Base -> league/Base.kt::Base.constructor@4 [instantiates]",
      "Plain.constructor: 8 new Base -> league/Base.kt::Base.constructor@3 [instantiates]",
      "Quiet.constructor: 10 new Base -> league/Base.kt::Base.constructor@3 [instantiates]",
    ]);
    expect(linksFrom(analyses, "league/Derived.kt").some((l) => l.includes("other/Base.kt"))).toBe(false);
  });

  it("a secondary constructor's this(…) reaches the sibling constructor its arguments choose", async () => {
    const analyses = await analyzeAll(files, "kotlin");
    const own = linksFrom(analyses, "league/Derived.kt").filter((l) => l.includes("new Derived"));
    expect(own).toEqual([
      "Derived.constructor: 4 new Derived -> league/Derived.kt::Derived.constructor@3 [instantiates]",
      "Derived.constructor: 5 new Derived -> league/Derived.kt::Derived.constructor@4 [instantiates]",
    ]);
  });

  it("a secondary constructor's super(…) reaches the superclass constructor its arguments choose", async () => {
    const analyses = await analyzeAll(files, "kotlin");
    expect(linksFrom(analyses, "league/Kid.kt").filter((l) => l.startsWith("Kid.") && l.includes("new Parent"))).toEqual([
      "Kid.constructor: 8 new Parent -> league/Kid.kt::Parent.constructor@4 [instantiates]",
      "Kid.constructor: 9 new Parent -> league/Kid.kt::Parent.constructor@3 [instantiates]",
    ]);
  });
});

describe("Kotlin secondary constructor bodies", () => {
  it("the statements after `: this(…)` are the constructor's calls", async () => {
    const analyses = await analyzeAll({
      "league/Club.kt": [
        "package league",
        "",
        "class Club(val n: Int) {",
        "    constructor() : this(0) { register(); announce() }",
        "}",
        "fun register() {}",
        "fun announce() {}",
        "",
      ].join("\n"),
    }, "kotlin");
    expect(linksFrom(analyses, "league/Club.kt").filter((l) => l.startsWith("Club.constructor")).map((l) => l.split(" [")[0])).toEqual([
      "Club.constructor: 4 announce -> league/Club.kt::announce@7",
      "Club.constructor: 4 new Club -> league/Club.kt::Club.constructor@3",
      "Club.constructor: 4 register -> league/Club.kt::register@6",
    ]);
  });
});

describe("Java anonymous classes", () => {
  const files = {
    "com/example/league/Base.java": [
      "package com.example.league;",
      "public abstract class Base {",
      "  protected void work() {}",
      "  public abstract void hook();",
      "}",
      "",
    ].join("\n"),
    "com/example/other/Base.java": [
      "package com.example.other;",
      "public abstract class Base {",
      "  protected void work() {}",
      "}",
      "",
    ].join("\n"),
    "com/example/league/Runner.java": [
      "package com.example.league;",
      "public class Runner {",
      "  void work() {}",
      "  void go() {",
      "    Base b = new Base() {",
      "      public void hook() { work(); }",
      "    };",
      "  }",
      "}",
      "",
    ].join("\n"),
    "com/example/league/Squad.java": [
      "package com.example.league;",
      "public class Squad {",
      "  private Club club;",
      "  void start() {",
      "    Runnable handler = new Runnable() {",
      "      public void run() { club.sign(); }",
      "    };",
      "    handler.run();",
      "    Other o = new Other();",
      "    o.run();",
      "  }",
      "}",
      "class Club { void sign() {} }",
      "class Other { void run() {} }",
      "",
    ].join("\n"),
  };

  it("a bare call inside an anonymous subclass resolves on its base, not the enclosing class or a namesake", async () => {
    const analyses = await analyzeAll(files, "java");
    const work = linksFrom(analyses, "com/example/league/Runner.java").filter((l) => l.includes(" work -> "));
    // Once, from the enclosing method — where the walk attributes the anonymous body's calls.
    expect(work).toEqual(["Runner.go: 6 work -> com/example/league/Base.java::Base.work@3 [calls]"]);
  });

  it("`handler.run()` reaches the anonymous class's run, and an unrelated run() is not linked to it", async () => {
    const analyses = await analyzeAll(files, "java");
    const links = linksFrom(analyses, "com/example/league/Squad.java");
    expect(links.filter((l) => l.includes(" handler.run "))).toEqual([
      "Squad.start: 8 handler.run -> com/example/league/Squad.java::Runnable$5_23.run@6 [calls]",
    ]);
    expect(links.filter((l) => l.includes(" o.run "))).toEqual([
      "Squad.start: 10 o.run -> com/example/league/Squad.java::Other.run@14 [calls]",
    ]);
    // The call inside the anonymous body is still the enclosing method's.
    expect(links.some((l) => l.startsWith("Squad.start: 6 club.sign"))).toBe(true);
  });

  it("a local built from an empty anonymous subclass is its base: inherited calls on it link (real-repo FP)", async () => {
    const analyses = await analyzeAll({
      ...files,
      "com/example/league/Kit.java": "package com.example.league;\npublic abstract class Kit { public void setColour(String c) {} }\n",
      "com/example/league/KitTest.java": [
        "package com.example.league;",
        "public class KitTest {",
        "  void paint() {",
        "    var kit = new Kit() {};",
        "    kit.setColour(\"red\");",
        "  }",
        "}",
        "",
      ].join("\n"),
    }, "java");
    expect(linksFrom(analyses, "com/example/league/KitTest.java").filter((l) => l.includes(" kit.setColour "))).toEqual([
      "KitTest.paint: 5 kit.setColour -> com/example/league/Kit.java::Kit.setColour@2 [calls]",
    ]);
  });
});
