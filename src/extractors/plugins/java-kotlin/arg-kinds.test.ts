import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars + call hooks
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinExtractor } from "./functions-classes.js";
import { javaOverloadTypeKey, kotlinOverloadTypeKey } from "./arg-kinds.js";
import type { CallInfo } from "../../../types/analysis.js";

async function callsOf(src: string, lang: "java" | "kotlin", method: string): Promise<CallInfo[]> {
  const tree = await parseSource(src, lang as any, lang === "java" ? "X.java" : "X.kt");
  const ex = new JavaKotlinExtractor();
  const all = [...ex.extractFunctions(tree, src), ...ex.extractClasses(tree, src).flatMap((c) => c.methods)];
  return all.find((f) => f.name === method)!.calls;
}

const kinds = (calls: CallInfo[], name: string) => calls.filter((c) => c.name === name).map((c) => c.argKinds ?? null);

describe("Java argument kinds", () => {
  it("reads literals, constructions, class literals, casts and lambdas off the expressions", async () => {
    const calls = await callsOf(`class Pit {
  void go(Car car, int lap) {
    String plate = "AB";
    long fuel = 2L;
    note("x", 1, 2L, 2.0, 2f, true, 'c', null);
    note(new Car(), Car.class, (Van) car, "lap " + lap, !ok);
    note(car, lap, plate, fuel, this.garage, unknown);
    run(() -> { System.out.println("x"); });
    run(() -> { return 3; });
    run(() -> save(car));
    run(x -> x + 1);
    run((a, b) -> { if (a) return; });
  }
}`, "java", "go");
    expect(kinds(calls, "note")).toEqual([
      ["string", "int", "long", "double", "float", "boolean", "char", "null"],
      ["Car", "Class", "Van", "string", "boolean"],
      // A parameter's and a local's type here; a field and an undeclared name are the linker's.
      ["Car", "int", "string", "long", "@garage", "@unknown"],
    ]);
    expect(kinds(calls, "run")).toEqual([["->0:void"], ["->0:value"], ["->0"], ["->1:value"], ["->2:void"]]);
  });

  it("keeps same-arity calls with different argument kinds apart", async () => {
    const calls = await callsOf(`class Pit { void go() { score("a", 1); score(new Object(), "t"); score("b", 2); } }`, "java", "go");
    expect(kinds(calls, "score")).toEqual([["string", "int"], ["object", "string"]]);
  });

  it("folds declared types to the chooser's keys", () => {
    expect(["Integer", "java.lang.String", "Object", "Supplier<T>", "Runnable", "Consumer<Car>", "BiFunction<A, B, C>", "List<Car>", "@NonNull Car", "byte[]"].map(javaOverloadTypeKey))
      .toEqual(["int", "string", "object", "->0:value", "->0:void", "->1:void", "->2:value", "List", "Car", "byte[]"]);
  });
});

describe("Kotlin argument kinds", () => {
  it("reads literals, constructions and lambdas, and keeps `write(\"plate\")` and `write(ByteArray(2))` apart", async () => {
    const calls = await callsOf(`class Mechanic {
  fun service(b: Bay, n: Int) {
    val tag = "x"
    b.write("plate")
    b.write(ByteArray(2))
    b.write(n)
    b.write(tag)
    b.load(1L, 2.0, true, 'c', null)
    b.each { it.check() }
    b.pair { a, c -> a }
    b.named(n = 2)
  }
}`, "kotlin", "service");
    expect(kinds(calls, "b.write")).toEqual([["string"], ["ByteArray"], ["int"], ["string"]]);
    expect(kinds(calls, "b.load")).toEqual([["long", "double", "boolean", "char", "null"]]);
    expect(kinds(calls, "b.each")).toEqual([["->"]]);
    expect(kinds(calls, "b.pair")).toEqual([["->2"]]);
    // A named argument may come in any order: no kinds.
    expect(kinds(calls, "b.named")).toEqual([null]);
  });

  it("folds function types and Kotlin's own names", () => {
    expect(["() -> Unit", "(Car) -> Int", "suspend () -> Unit", "Int", "Any?", "String?", "Long"].map(kotlinOverloadTypeKey))
      .toEqual(["->0:void", "->1:value", "->0:void", "int", "object", "string", "long"]);
  });
});
