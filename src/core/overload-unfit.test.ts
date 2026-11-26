/**
 * E-364: an overload link the arguments rule out is never kept. A tie keeps
 * the link on one of the tied overloads (never a body outside the set); a call
 * no overload's arity accepts links to nothing, in every language that states
 * parameters. Through the real per-file pipeline, then the linker.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis, Language } from "../types/analysis.js";

async function analyzeAll(files: Record<string, string>, language: Language): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "unfit-"));
  const out = await mkdtemp(join(tmpdir(), "unfit-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language },
      frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false },
      verbose: false, projectRoot: root, tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

function callsFrom(analyses: FileAnalysis[], from: string): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.sourceFile === from && l.sourceSymbol !== "(reference)")
    .map((l) => `${l.sourceLine} ${l.callName} -> ${l.targetSymbol}@${l.targetLine} [${l.strategy}${l.overloadsFit ? ` fit=${l.overloadsFit}` : ""}${l.confidence === "AMBIGUOUS" ? " ambiguous" : ""}]`)
    .sort();
}

describe("overload choice never keeps an unfit link", () => {
  it("Java: a tie stays on a tied constructor, not the caller's own; the decoy keeps its link", async () => {
    const a = await analyzeAll({
      "garage/Garage.java": [
        "package garage;",
        "class Mapper { Node createNode() { return null; } }",
        "class Node {}",
        "class Car {}",
        "public class Garage {",
        "    Garage(Mapper m) { this(m, m.createNode()); }",
        "    Garage(Mapper m, Node n) {}",
        "    Garage(Mapper m, Car c) {}",
        "    static void open(Mapper m) {",
        "        new Garage(m, new Car());",
        "    }",
        "}",
      ].join("\n"),
    }, "java");
    const calls = callsFrom(a, "garage/Garage.java");
    const tie = calls.find((c) => c.startsWith("6 new Garage"));
    expect(tie).toMatch(/@7 \[constructor fit=2 ambiguous\]/);
    // The decoy: the arguments tell (`new Car()`), so the exact overload stays, unmarked.
    expect(calls.find((c) => c.startsWith("10 new Garage"))).toMatch(/@8 \[constructor\]/);
  });

  it("Java: a call no overload's arity accepts links to nothing", async () => {
    const a = await analyzeAll({
      "garage/Garage.java": [
        "package garage;",
        "public class Garage {",
        "    void park(int a) {}",
        "    void park(int a, int b) {}",
        "    void one(Garage g) { g.park(1); }\n void three(Garage g) { g.park(1, 2, 3); }",
        "}",
      ].join("\n"),
    }, "java");
    const calls = callsFrom(a, "garage/Garage.java").filter((c) => c.includes("park"));
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/^5 .*@3 /);
  });

  it("C#: an extension method's receiver counts; a surplus argument links to nothing", async () => {
    const a = await analyzeAll({
      "Cars/Ext.cs": [
        "namespace Cars {",
        "  public static class Ext {",
        "    public static void Wash(this Car c) {}",
        "    public static void Wash(this Car c, int times) {}",
        "  }",
        "  public class Car {}",
        "}",
      ].join("\n"),
      "Cars/Use.cs": [
        "using Cars;",
        "namespace Cars {",
        "  public class Use {",
        "    void A(Car car) { car.Wash(); }",
        "    void B(Car car) { car.Wash(2); }",
        "    void C(Car car) { car.Wash(1, 2, 3); }",
        "    void D(Car car) { Ext.Wash(car, 2); }",
        "  }",
        "}",
      ].join("\n"),
    }, "csharp");
    const calls = callsFrom(a, "Cars/Use.cs");
    expect(calls.some((c) => c.startsWith("4 "))).toBe(true);
    expect(calls.some((c) => c.startsWith("5 "))).toBe(true);
    expect(calls.some((c) => c.startsWith("6 "))).toBe(false);
    // The static form passes the receiver as the first argument: still a call the method takes.
    expect(calls.some((c) => c.startsWith("7 "))).toBe(true);
  });

  it("Kotlin: a default value counts; a surplus argument links to nothing", async () => {
    const a = await analyzeAll({
      "league/Club.kt": [
        "package league",
        "class Club {",
        "    fun sign(name: String, years: Int = 2) {}",
        "    fun sign(name: String, years: Int, fee: Int) {}",
        "    fun a(c: Club) { c.sign(\"a\") }",
        "    fun b(c: Club) { c.sign(\"a\", 1, 2) }",
        "    fun c(c: Club) { c.sign(\"a\", 1, 2, 3) }",
        "}",
      ].join("\n"),
    }, "kotlin");
    const calls = callsFrom(a, "league/Club.kt").filter((c) => c.includes("sign"));
    expect(calls.some((c) => c.startsWith("5 "))).toBe(true);
    expect(calls.some((c) => c.startsWith("6 "))).toBe(true);
    expect(calls.some((c) => c.startsWith("7 "))).toBe(false);
  });

  it("C++: a surplus argument links to nothing", async () => {
    const a = await analyzeAll({
      "garage.cpp": [
        "void park(int a) {}",
        "void park(int a, int b) {}",
        "void a() { park(1); }",
        "void b() { park(1, 2, 3); }",
      ].join("\n"),
    }, "cpp");
    const calls = callsFrom(a, "garage.cpp").filter((c) => c.includes("park"));
    expect(calls.some((c) => c.startsWith("3 "))).toBe(true);
    expect(calls.some((c) => c.startsWith("4 "))).toBe(false);
  });
});
