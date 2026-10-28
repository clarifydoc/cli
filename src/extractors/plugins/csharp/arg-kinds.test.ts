import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars + call hooks
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractClasses } from "../../functions-classes/index.js";
import { csharpOverloadTypeKey } from "./arg-kinds.js";
import type { CallInfo } from "../../../types/analysis.js";

async function callsOf(body: string): Promise<CallInfo[]> {
  const src = `class Garage { void Service(Car car, int bay) {\n${body}\n} }`;
  const tree = await parseSource(src, "csharp" as any, "Garage.cs");
  return extractClasses(tree, src, "csharp")[0]!.methods[0]!.calls;
}

const kinds = (calls: CallInfo[], name: string) => calls.filter((c) => c.name === name).map((c) => c.argKinds ?? null);

describe("C# argument kinds", () => {
  it("reads literals, constructions, typeof, casts, variables and lambdas", async () => {
    const calls = await callsOf(`
      string plate = "AB";
      var count = 3L;
      Note("x", $"b{bay}", 1, 1L, 2.0, 2f, 2m, true, 'c', null);
      Note(new Car(), typeof(Car), (Van) car, nameof(car));
      Note(car, bay, plate, count, this._lot, unknown);
      Run(() => { Console.WriteLine("x"); });
      Run(() => { return 3; });
      Run(() => Save(car));
      Run(x => x + 1);
      Note(bay: 2);`);
    expect(kinds(calls, "Note")).toEqual([
      ["string", "string", "int", "long", "double", "float", "decimal", "boolean", "char", "null"],
      ["Car", "Type", "Van", "string"],
      ["Car", "int", "string", "long", "@_lot", "@unknown"],
      null, // a named argument may come in any order
    ]);
    expect(kinds(calls, "Run")).toEqual([["->0:void"], ["->0:value"], ["->0"], ["->1:value"]]);
  });

  it("folds keyword types, System structs and delegates", () => {
    expect(["Int32", "System.String", "int?", "object", "Action", "Action<Car, int>", "Func<Car>", "Func<Car, bool>", "Expression<Func<Car, bool>>", "List<Car>"].map(csharpOverloadTypeKey))
      .toEqual(["int", "string", "int", "object", "->0:void", "->2:void", "->0:value", "->1:value", "->1:value", "List"]);
  });
});
