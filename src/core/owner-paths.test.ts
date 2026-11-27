import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { ownerIndex, qualifyNestedSymbols } from "./owner-paths.js";
import type { ClassInfo, ComplexityInfo, FileAnalysis, FunctionInfo, ProjectAnalysis, SymbolLink } from "../types/analysis.js";

/**
 * An element id carries the owner path of a nested or function-local symbol, joined with `.` in every language:
 * two nested `Builder`s of one file are `Left.Builder.build` and `Right.Builder.build`; a type declared inside
 * a function is `migrate.Row`. A top-level symbol keeps its name.
 */

const fn = (name: string, line: number, endLine = line + 2): FunctionInfo =>
  ({ name, line, endLine, params: [], calls: [], returnType: null, isAsync: false, isExported: true, decorators: [] });

const cls = (name: string, line: number, endLine: number, methods: FunctionInfo[] = [], extra: Partial<ClassInfo> = {}): ClassInfo =>
  ({ name, kind: "class", extends: null, implements: [], methods, properties: [], decorators: [], isExported: true, line, endLine, ...extra });

const complexity = (functionName: string, line: number, endLine: number): ComplexityInfo =>
  ({ functionName, complexity: 1, line, endLine, cognitive: 0, nestingDepth: 0, paramCount: 0 });

const file = (filePath: string, classes: ClassInfo[], functions: FunctionInfo[] = [], complexities: ComplexityInfo[] = []): FileAnalysis =>
  ({ filePath, projectId: "root", language: "java", functions, classes, imports: [], exports: [], routes: [], dataSources: [], complexities } as unknown as FileAnalysis);

describe("ownerIndex", () => {
  const nested = file("Both.java", [
    cls("Left", 1, 10), cls("Builder", 2, 9, [fn("build", 4)]),
    cls("Right", 11, 20), cls("Builder", 12, 19, [fn("build", 14)]),
    cls("Garage", 21, 30, [fn("park", 23)]),
  ], [], [complexity("Builder.build", 4, 6), complexity("Builder.build", 14, 16), complexity("Garage.park", 23, 25)]);
  const ix = ownerIndex(nested);

  it("gives two nested namesakes distinct ids by owner", () => {
    expect(ix.classSymbol("Builder", 2)).toBe("Left.Builder");
    expect(ix.classSymbol("Builder", 12)).toBe("Right.Builder");
    expect(ix.functionSymbol("Builder.build", 4)).toBe("Left.Builder.build");
    expect(ix.functionSymbol("Builder.build", 14)).toBe("Right.Builder.build");
  });

  it("keeps a top-level class and its methods exactly", () => {
    expect(ix.classSymbol("Garage", 21)).toBe("Garage");
    expect(ix.classSymbol("Left", 1)).toBe("Left");
    expect(ix.functionSymbol("Garage.park", 23)).toBe("Garage.park");
  });

  it("finds the function a call line lies in, and says an ambiguous name stands for both", () => {
    expect(ix.functionContaining("Builder.build", 15)).toBe("Right.Builder.build");
    expect(ix.symbolNamed("Builder.build")).toBeUndefined();
    expect(ix.symbolNamed("Garage.park")).toBe("Garage.park");
  });

  it("names a type declared inside a function by that function", () => {
    const local = ownerIndex(file("x.py", [cls("Fake", 3, 6, [fn("run", 4)])], [fn("test_a", 2, 7)], [complexity("test_a", 2, 7), complexity("Fake.run", 4, 6)]));
    expect(local.classSymbol("Fake", 3)).toBe("test_a.Fake");
    expect(local.functionSymbol("Fake.run", 4)).toBe("test_a.Fake.run");
    expect(local.functionSymbol("test_a", 2)).toBe("test_a");
  });

  it("leaves a function inside a function, and two one-line classes, as they are", () => {
    const flat = ownerIndex(file("x.js", [cls("A", 1, 1), cls("B", 1, 1)], [fn("outer", 3, 9), fn("inner", 4, 6)]));
    expect(flat.nested).toBe(false);
    expect(flat.functionSymbol("inner", 4)).toBe("inner");
  });

  it("names a generated member of a nested one-line record, and a member the file's functions do not list", () => {
    const rec = ownerIndex(file("Reconciler.java", [cls("Reconciler", 1, 20), cls("Request", 5, 5, [fn("name", 5, 5)])], [], [complexity("Reconciler.run", 2, 3)]));
    expect(rec.functionSymbol("Request.name", 5)).toBe("Reconciler.Request.name");
    expect(rec.functionSymbol("Request.extra", 5)).toBe("Reconciler.Request.extra");
    // two classes of the name leave an unlisted member as written
    const two = ownerIndex(file("Two.java", [cls("A", 1, 10), cls("Request", 2, 4), cls("B", 11, 20), cls("Request", 12, 14)]));
    expect(two.functionSymbol("Request.extra", 99)).toBe("Request.extra");
  });

  it("reads no nesting into a language whose class lines are an envelope (Go methods declared outside the type)", () => {
    const envelope = ownerIndex(file("magefile.go", [cls("Dev", 10, 90, [fn("Prepare", 12)]), cls("Generate", 40, 60, [fn("Client", 42)])]), false);
    expect(envelope.nested).toBe(false);
    expect(envelope.classSymbol("Generate", 40)).toBe("Generate");
  });

  it("takes the owner a plugin states where the lines do not show it", () => {
    const ts = ownerIndex(file("n.ts", [cls("Builder", 2, 6, [fn("build", 3)], { owner: "Left" })], [], [complexity("Builder.build", 3, 5)]));
    expect(ts.classSymbol("Builder", 2)).toBe("Left.Builder");
    expect(ts.functionSymbol("Builder.build", 3)).toBe("Left.Builder.build");
  });

  it("reads a class a plugin already writes through its owner once (`Left::Builder` inside `Left`)", () => {
    const cpp = ownerIndex(file("n.cpp", [cls("Left", 1, 10), cls("Left::Builder", 2, 9, [fn("build", 4)])], [fn("build", 4)], [complexity("Left::Builder.build", 4, 6)]));
    expect(cpp.classSymbol("Left::Builder", 2)).toBe("Left.Builder");
    expect(cpp.functionSymbol("Left::Builder.build", 4)).toBe("Left.Builder.build");
    // a bare member name of a nested class
    expect(cpp.functionSymbol("build", 4)).toBe("Left.Builder.build");
  });
});

describe("qualifyNestedSymbols", () => {
  const both = file("Both.java", [
    cls("Left", 1, 10), cls("Builder", 2, 9, [fn("build", 4)]),
    cls("Right", 11, 20), cls("Builder", 12, 19, [fn("build", 14)]),
  ], [], [complexity("Builder.build", 4, 6), complexity("Builder.build", 14, 16)]);
  const decoy = file("Other.java", [cls("Builder", 1, 8, [fn("build", 3)])], [], [complexity("Builder.build", 3, 5)]);
  const link = (over: Partial<SymbolLink>): SymbolLink =>
    ({ sourceFile: "Garage.java", sourceSymbol: "Garage.go", sourceLine: 4, callName: "Right.Builder.build", targetFile: "Both.java", targetSymbol: "Builder.build", targetLine: 14, ...over });

  it("rewrites the sections that name a symbol, by the line each states", () => {
    const project = {
      symbolLinks: [link({}), link({ targetLine: 4 }), link({ targetFile: "Other.java", targetLine: 3 }), link({ sourceFile: "Both.java", sourceSymbol: "Builder.build", sourceLine: 15, targetFile: "Garage.java", targetSymbol: "Garage.go", targetLine: 1 })],
      complexity: [
        { filePath: "Both.java", totalComplexity: 2, maxComplexity: 1, averageComplexity: 1, functions: [complexity("Builder.build", 4, 6), complexity("Builder.build", 14, 16)] },
        { filePath: "Other.java", totalComplexity: 1, maxComplexity: 1, averageComplexity: 1, functions: [complexity("Builder.build", 3, 5)] },
      ],
    } as unknown as ProjectAnalysis;
    const counts = qualifyNestedSymbols(project, [both, decoy]);
    expect(project.symbolLinks!.map((l) => `${l.sourceSymbol} -> ${l.targetFile}:${l.targetSymbol}`)).toEqual([
      "Garage.go -> Both.java:Right.Builder.build",
      "Garage.go -> Both.java:Left.Builder.build",
      "Garage.go -> Other.java:Builder.build", // the decoy's file has no nesting: untouched
      "Right.Builder.build -> Garage.java:Garage.go",
    ]);
    expect(project.complexity![0]!.functions.map((f) => f.functionName)).toEqual(["Left.Builder.build", "Right.Builder.build"]);
    expect(project.complexity![1]!.functions.map((f) => f.functionName)).toEqual(["Builder.build"]);
    expect(counts.symbolLinks).toBe(3);
    expect(counts.complexity).toBe(2);
  });

  it("changes nothing in a project with no nesting", () => {
    const project = { symbolLinks: [link({ targetFile: "Other.java", targetLine: 3 })] } as unknown as ProjectAnalysis;
    expect(qualifyNestedSymbols(project, [decoy])).toMatchObject({ symbolLinks: 0, complexity: 0, symbolDataAccess: 0, symbolReach: 0 });
    expect(project.symbolLinks![0]!.targetSymbol).toBe("Builder.build");
  });

  it("leaves a symbolReach row whose name two declarations share, and qualifies one only a nested declaration has", () => {
    const project = {
      symbolReach: [{ file: "Both.java", symbol: "Builder.build" }, { file: "Both.java", symbol: "Right" }],
    } as unknown as ProjectAnalysis;
    qualifyNestedSymbols(project, [both]);
    expect(project.symbolReach!.map((r) => r.symbol)).toEqual(["Builder.build", "Right"]);
    const one = file("One.java", [cls("Outer", 1, 9), cls("Inner", 2, 8, [fn("go", 4)])], [], [complexity("Inner.go", 4, 6)]);
    const p2 = { symbolReach: [{ file: "One.java", symbol: "Inner.go" }] } as unknown as ProjectAnalysis;
    qualifyNestedSymbols(p2, [one]);
    expect(p2.symbolReach![0]!.symbol).toBe("Outer.Inner.go");
  });
});

/** The shape, end to end, in the languages whose plugins nest (Java, C#, TypeScript namespace, Python, C++). */
describe("owner-qualified ids, end to end", () => {
  let dir = "";
  let summary: Record<string, any>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-owner-paths-"));
    const root = join(dir, "repo");
    const files: Record<string, string> = {
      "Nested.java": [
        "class Left {", "    static class Builder {", "        static int build() {", "            return 1;", "        }", "    }", "}", "",
        "class Right {", "    static class Builder {", "        static int build() {", "            return 2;", "        }", "    }", "}", "",
        "class Garage {", "    void go() {", "        Right.Builder.build();", "    }", "}", "",
      ].join("\n"),
      "Decoy.java": ["class Builder {", "    static int build() {", "        return 3;", "    }", "}", ""].join("\n"),
      "N.cs": [
        "namespace Example.League", "{", "    public class Left", "    {", "        public class Builder", "        {", "            public static int Build() { return 1; }", "        }", "    }", "",
        "    public class Right", "    {", "        public class Builder", "        {", "            public static int Build() { return 2; }", "        }", "    }", "}", "",
      ].join("\n"),
      "n.ts": [
        "export namespace Left {", "  export class Builder {", "    static build(): number {", "      return 1;", "    }", "  }", "}", "",
        "export namespace Right {", "  export class Builder {", "    static build(): number {", "      return 2;", "    }", "  }", "}", "",
      ].join("\n"),
      "n.py": [
        "class Left:", "    class Builder:", "        def build(self):", "            return 1", "",
        "class Right:", "    class Builder:", "        def build(self):", "            return 2", "",
        "def test_a():", "    class Fake:", "        def run(self):", "            return 1", "    return Fake().run()", "",
        "def test_b():", "    class Fake:", "        def run(self):", "            return 2", "    return Fake().run()", "",
      ].join("\n"),
      "n.cpp": [
        "namespace league {", "struct Left {", "  struct Builder {", "    static int build() {", "      return 1;", "    }", "  };", "};", "",
        "struct Right {", "  struct Builder {", "    static int build() {", "      return 2;", "    }", "  };", "};", "}", "",
        "int go() {", "  return league::Right::Builder::build();", "}", "",
      ].join("\n"),
      "o.h": [
        "class Left {", " public:", "  class Builder {", "   public:", "    void build();", "    static int make();", "  };", "};", "",
        "class Right {", " public:", "  class Builder {", "   public:", "    void build() {", "      stamp();", "    }", "  };", "};", "",
        "class Builder {", " public:", "  void build();", "};", "",
      ].join("\n"),
      "o.cpp": [
        '#include "o.h"', "", "void Left::Builder::build() {", "  stamp();", "}", "", "int Left::Builder::make() {", "  return 1;", "}", "",
        "void Builder::build() {", "}", "",
        "void useLeft() {", "  Left::Builder::make();", "}", "",
        "void useRight() {", "  Right::Builder r;", "  r.build();", "}", "",
        "void useTop() {", "  Builder t;", "  t.build();", "}", "",
      ].join("\n"),
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = (await loadReportSummary(join(dir, "out"))) as Record<string, any>;
  }, 60_000);
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  const functions = (path: string): string[] =>
    (summary.complexity as Array<{ filePath: string; functions: Array<{ functionName: string }> }>).find((c) => c.filePath === path)!.functions.map((f) => f.functionName).sort();

  it.each([
    ["Nested.java", ["Garage.go", "Left.Builder.build", "Right.Builder.build"]],
    ["N.cs", ["Left.Builder.Build", "Right.Builder.Build"]],
    ["n.ts", ["Left.Builder.build", "Right.Builder.build"]],
    ["n.py", ["Left.Builder.build", "Right.Builder.build", "test_a", "test_a.Fake.run", "test_b", "test_b.Fake.run"]],
  ])("%s: nested namesakes get owner-qualified ids", (path, expected) => {
    expect(functions(path)).toEqual(expected);
  });

  it("spells a C++ nested class by its path with `.` too, from the qualified name its plugin states", () => {
    expect(functions("n.cpp")).toEqual(["Left.Builder.build", "Right.Builder.build", "go"]);
  });

  it("names a C++ member defined outside its class by the class's path, and keeps a top-level namesake plain", () => {
    expect(functions("o.cpp")).toEqual(["Builder.build", "Left.Builder.build", "Left.Builder.make", "useLeft", "useRight", "useTop"]);
    const to = (call: string): string[] =>
      (summary.symbolLinks as Array<{ sourceSymbol: string; targetFile: string; targetSymbol: string; callName: string }>)
        .filter((l) => l.callName === call).map((l) => `${l.targetFile}:${l.targetSymbol}`);
    expect(to("Left::Builder.make")).toEqual(["o.cpp:Left.Builder.make"]);
    expect(to("r.build")).toEqual(["o.h:Right.Builder.build"]);
    expect(to("t.build")).toEqual(["o.cpp:Builder.build"]);
  });

  it("leaves a decoy namesake in a file with no nesting untouched", () => {
    expect(functions("Decoy.java")).toEqual(["Builder.build"]);
  });

  it("links the E-233 call to the nested method and names it by its owner path", () => {
    const links = (summary.symbolLinks as Array<{ sourceSymbol: string; targetFile: string; targetSymbol: string; callName: string }>)
      .filter((l) => l.callName === "Right.Builder.build" || l.callName === "Right::Builder.build");
    expect(links.map((l) => `${l.targetFile}:${l.targetSymbol}`).sort()).toEqual(["Nested.java:Right.Builder.build", "n.cpp:Right.Builder.build"]);
  });

  it("gives the two function-local classes of one name distinct link targets", () => {
    const targets = (summary.symbolLinks as Array<{ targetFile: string; targetSymbol: string }>).filter((l) => l.targetFile === "n.py").map((l) => l.targetSymbol);
    expect(targets).toContain("test_a.Fake");
    expect(targets).toContain("test_b.Fake");
  });
});

describe("symbolAnswersTo", () => {
  it("answers to the leaf, the id's path and the `::` label a person types for a C++ nested class", async () => {
    const { symbolAnswersTo } = await import("./owner-paths.js");
    for (const want of ["builder.build", "right.builder.build", "right::builder.build", "right.builder.build"]) expect(symbolAnswersTo("Right.Builder.build", want)).toBe(true);
    expect(symbolAnswersTo("Left.Builder.build", "right::builder.build")).toBe(false);
  });
});
