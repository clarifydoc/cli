import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { ownerIndex, parameterTypes, symbolAnswersTo, bareSymbol } from "./owner-paths.js";
import type { ClassInfo, FileAnalysis, FunctionInfo, ParamInfo } from "../types/analysis.js";

/**
 * Where a name is overloaded within its class (or file, for a free function), the id carries the parameter types as
 * written, whitespace dropped, no names: `Squad.Pick(int,string)`. A name declared once keeps its name; a property's
 * accessor pair is no overload.
 */

const param = (type: string | null, name = "p"): ParamInfo => ({ name, type, defaultValue: null });
const fn = (name: string, line: number, params: ParamInfo[], extra: Partial<FunctionInfo> = {}): FunctionInfo =>
  ({ name, line, endLine: line, params, calls: [], returnType: null, isAsync: false, isExported: true, decorators: [], ...extra });
const cls = (name: string, line: number, endLine: number, methods: FunctionInfo[]): ClassInfo =>
  ({ name, kind: "class", extends: null, implements: [], methods, properties: [], decorators: [], isExported: true, line, endLine });
const file = (language: string, classes: ClassInfo[], functions: FunctionInfo[] = []): FileAnalysis =>
  ({ filePath: "Squad.x", projectId: "root", language, functions, classes, imports: [], exports: [], routes: [], dataSources: [], complexities: [] } as unknown as FileAnalysis);

describe("parameterTypes", () => {
  it("writes the types as written, whitespace dropped, an untyped parameter `_`", () => {
    expect(parameterTypes([param("List< String >"), param(null), param("int")])).toBe("List<String>,_,int");
    expect(parameterTypes([])).toBe("");
    // Two words keep one space between them, never glued: `const string`, VB `Func(Of T, Task)`.
    expect(parameterTypes([param("const  string"), param("Func(Of T, Task)")])).toBe("const string,Func(Of T,Task)");
  });
});

describe("overload ids, per file", () => {
  const squad = cls("Squad", 1, 20, [fn("Pick", 2, []), fn("Pick", 3, [param("int")]), fn("Pick", 4, [param("string")]), fn("Pick", 5, [param("int"), param("string", "who")]), fn("Count", 6, [])]);
  const club = cls("Club", 21, 30, [fn("Pick", 22, [])]);

  it("spells each overload by its parameter types and leaves a lone method alone", () => {
    const ix = ownerIndex(file("csharp", [squad, club]));
    expect(ix.functionSymbol("Squad.Pick", 2)).toBe("Squad.Pick()");
    expect(ix.functionSymbol("Squad.Pick", 3)).toBe("Squad.Pick(int)");
    expect(ix.functionSymbol("Squad.Pick", 5)).toBe("Squad.Pick(int,string)");
    expect(ix.functionSymbol("Squad.Count", 6)).toBe("Squad.Count");
    expect(ix.functionSymbol("Club.Pick", 22)).toBe("Club.Pick");
    expect(ix.overloadGroups).toBe(1);
  });

  it("composes with the owner path of a nested class", () => {
    const outer = cls("Squad", 1, 20, []);
    const inner = cls("Builder", 2, 10, [fn("Add", 3, [param("int")]), fn("Add", 4, [param("string")])]);
    const ix = ownerIndex(file("java", [outer, inner]));
    expect(ix.functionSymbol("Builder.Add", 3)).toBe("Squad.Builder.Add(int)");
    expect(ix.functionSymbol("Builder.Add", 4)).toBe("Squad.Builder.Add(string)");
  });

  it("types free functions of an overloading language, and counts members that still spell alike", () => {
    const free = ownerIndex(file("cpp", [], [fn("pick", 1, [param("int")]), fn("pick", 2, [param("double")])]));
    expect(free.functionSymbol("pick", 1)).toBe("pick(int)");
    const alike = ownerIndex(file("swift", [cls("Squad", 1, 9, [fn("pick", 2, [param("String")]), fn("pick", 3, [param("String")]), fn("pick", 4, [param("Int")])])]));
    expect(alike.functionSymbol("Squad.pick", 2)).toBe("Squad.pick");
    expect(alike.functionSymbol("Squad.pick", 3)).toBe("Squad.pick");
    expect(alike.functionSymbol("Squad.pick", 4)).toBe("Squad.pick(Int)");
    expect(alike.unsplitOverloadGroups).toBe(1);
  });

  it("never reads an accessor pair, or a language without overloading, as overloads", () => {
    const props = cls("Squad", 1, 9, [fn("size", 2, [], { accessor: "get" }), fn("size", 3, [param("number")], { accessor: "set" })]);
    expect(ownerIndex(file("typescript", [props])).functionSymbol("Squad.size", 3)).toBe("Squad.size");
    const python = cls("Squad", 1, 9, [fn("size", 2, []), fn("size", 3, [param(null)])]);
    expect(ownerIndex(file("python", [python])).functionSymbol("Squad.size", 3)).toBe("Squad.size");
  });
});

describe("naming an overload", () => {
  it("answers to the name for every overload and to the types for one", () => {
    expect(symbolAnswersTo("Squad.Pick(int)", "squad.pick")).toBe(true);
    expect(symbolAnswersTo("Squad.Pick(string)", "pick")).toBe(true);
    expect(symbolAnswersTo("Squad.Pick(int)", "squad.pick(int)")).toBe(true);
    expect(symbolAnswersTo("Squad.Pick(string)", "squad.pick(int)")).toBe(false);
    expect(symbolAnswersTo("Club.Pick", "squad.pick")).toBe(false);
    expect(bareSymbol("Squad.Pick(int,string)")).toBe("Squad.Pick");
  });
});

describe("overload ids, end to end", () => {
  let dir = "";
  let summary: Record<string, any>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-overload-ids-"));
    const root = join(dir, "repo");
    const files: Record<string, string> = {
      "Squad.cs": [
        "namespace Example.League", "{", "    public class Squad", "    {", "        public int Pick() { return 0; }", "        public int Pick(int n) { return n; }",
        "        public int Pick(string who) { return 1; }", "        public int Pick(int n, string who) { return 2; }", "        public int Count { get { return 1; } set { } }",
        "        public class Builder", "        {", "            public void Add(int a) { }", "            public void Add(string a) { }", "        }", "    }",
        "    public class Club", "    {", "        public int Pick() { return 3; }", "    }",
        "    public class Garage", "    {", "        public void Go(Squad s)", "        {", "            s.Pick();", "            s.Pick(1);", "            s.Pick(\"a\");", "            s.Pick(1, \"a\");", "        }", "    }", "}", "",
      ].join("\n"),
      "Squad.java": [
        "class Squad {", "    int pick() { return 0; }", "    int pick(int n) { return n; }", "    int pick(String who) { return 1; }", "    int pick(int n, String who) { return 2; }", "}", "",
        "class Club {", "    int pick() { return 3; }", "}", "",
        "class Garage {", "    void go(Squad s) {", "        s.pick();", "        s.pick(1);", "        s.pick(\"a\");", "        s.pick(1, \"a\");", "    }", "}", "",
      ].join("\n"),
      "Squad.kt": [
        "class Squad {", "    fun pick(): Int { return 0 }", "    fun pick(n: Int): Int { return n }", "    fun pick(who: String): Int { return 1 }", "}", "",
        "class Garage {", "    fun go(s: Squad) {", "        s.pick()", "        s.pick(1)", "        s.pick(\"a\")", "    }", "}", "",
      ].join("\n"),
      "squad.cpp": [
        "class Squad {", "public:", "    int pick() { return 0; }", "    int pick(int n) { return n; }", "    int pick(int n, std::string who) { return 2; }", "};", "",
        "int go(Squad& s) {", "    s.pick();", "    s.pick(1);", "    return s.pick(2, \"a\");", "}", "",
      ].join("\n"),
      "squad.ts": [
        "export class Squad {", "  pick(): number;", "  pick(n: number): number;", "  pick(n?: number): number {", "    return n ?? 0;", "  }",
        "  private _size = 0;", "  get size(): number {", "    return this._size;", "  }", "  set size(v: number) {", "    this._size = v;", "  }", "}", "",
      ].join("\n"),
      "squad.py": [
        "class Squad:", "    def __init__(self):", "        self._size = 0", "", "    @property", "    def size(self):", "        return self._size", "",
        "    @size.setter", "    def size(self, v):", "        self._size = v", "",
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
  const targets = (path: string) =>
    (summary.symbolLinks as Array<{ sourceFile: string; sourceLine: number; targetSymbol: string; targetLine: number }>)
      .filter((l) => l.sourceFile === path).map((l) => `${l.sourceLine}->${l.targetLine} ${l.targetSymbol}`).sort();

  it("C#: four overloads, a nested class's overloads, and unchanged lone methods", () => {
    expect(functions("Squad.cs")).toEqual(["Club.Pick", "Garage.Go", "Squad.Builder.Add(int)", "Squad.Builder.Add(string)", "Squad.Count", "Squad.Pick()", "Squad.Pick(int)", "Squad.Pick(int,string)", "Squad.Pick(string)"]);
    expect(targets("Squad.cs")).toEqual(["24->5 Squad.Pick()", "25->6 Squad.Pick(int)", "26->7 Squad.Pick(string)", "27->8 Squad.Pick(int,string)"]);
  });
  it("Java and Kotlin: each call lands on its own line and names the typed id", () => {
    expect(functions("Squad.java")).toEqual(["Club.pick", "Garage.go", "Squad.pick()", "Squad.pick(String)", "Squad.pick(int)", "Squad.pick(int,String)"]);
    expect(targets("Squad.java")).toEqual(["14->2 Squad.pick()", "15->3 Squad.pick(int)", "16->4 Squad.pick(String)", "17->5 Squad.pick(int,String)"]);
    expect(functions("Squad.kt")).toContain("Squad.pick(Int)");
    expect(targets("Squad.kt")).toEqual(["10->3 Squad.pick(Int)", "11->4 Squad.pick(String)", "9->2 Squad.pick()"]);
  });
  it("C++: free and member overloads by their written types", () => {
    expect(functions("squad.cpp")).toEqual(["Squad.pick()", "Squad.pick(int)", "Squad.pick(int,string)", "go"]);
  });
  it("TypeScript: an implementation alone is not an overload, and a getter/setter pair is one property", () => {
    expect(functions("squad.ts")).toEqual(["Squad.pick", "Squad.size", "Squad.size"]);
  });
  it("Python: a property and its setter keep their ids", () => {
    expect(functions("squad.py")).toEqual(["Squad.__init__", "Squad.size", "Squad.size"]);
  });
});
