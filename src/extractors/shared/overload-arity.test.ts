import { describe, it, expect } from "vitest";
import "../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../parsers/parser-manager.js";
import { extractClasses } from "../functions-classes/index.js";
import type { Language } from "../../types/analysis.js";

/** What the linker's overload pass reads: each method's parameters and each call's argument count. */
async function methodsOf(src: string, language: Language, file: string) {
  const tree = await parseSource(src, language as never, file);
  return extractClasses(tree, src, language)[0]!.methods;
}

describe("overload arity facts", () => {
  it("Java: argument counts, and a variadic parameter by its own name", async () => {
    const [emit, run] = await methodsOf(`class S {
  void emit(String level, String... parts) {}
  void run(Order o) { save(o); save(o, true); emit("a", "b", "c"); }
}`, "java", "S.java");
    expect(emit!.params.map((p) => [p.name, p.variadic ?? false])).toEqual([["level", false], ["parts", true]]);
    // Two `save` calls of different arity both stay: they may be two overloads.
    expect(run!.calls.map((c) => [c.name, c.argCount])).toEqual([["save", 1], ["save", 2], ["emit", 3]]);
  });

  it("C#: argument counts, defaults and `params`", async () => {
    const [add, run] = await methodsOf(`class R {
  void Add(Order o, bool flush, string tag = "x", params string[] rest) { }
  void Run() { Add(null, flush: true); }
}`, "csharp", "R.cs");
    expect(add!.params.map((p) => [p.name, p.defaultValue, p.variadic ?? false])).toEqual([
      ["o", null, false], ["flush", null, false], ["tag", "\"x\"", false], ["rest", null, true],
    ]);
    expect(run!.calls.map((c) => [c.name, c.argCount])).toEqual([["Add", 2]]);
  });

  it("Kotlin: a trailing lambda counts, a spread makes the count unknown", async () => {
    const [run] = await methodsOf(`class K {
  fun run(xs: Array<String>) { save(o) { it } ; emit(*xs) }
}`, "kotlin", "K.kt");
    expect(run!.calls.map((c) => [c.name, c.argCount])).toEqual([["save", 2], ["emit", undefined]]);
  });
});
