import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractClasses } from "../../functions-classes/index.js";
import { createEmptyAnalysis } from "../../../types/analysis.js";
import { preprocessCsharp, rewriteExtensionBlocks } from "./extension-blocks.js";

const SRC = `namespace Garage;
public static class CarExtensions
{
    extension(Car car)
    {
        public bool IsFast => car.Speed > 100;
        public void Honk() { Horn.Sound(car.Speed); }
        public static Car Build() => new Car();
    }
    extension<T>(List<T> items) where T : Car
    {
        public T Fastest() => items[0];
    }
    public static void Wash(this Car car) { Horn.Sound(1); }
}`;

async function analyzed(src: string, path = "CarExtensions.cs") {
  const pre = preprocessCsharp(src, path)!;
  const tree = await parseSource(pre.sourceText, "csharp" as never, path);
  const a = createEmptyAnalysis(path, "csharp");
  a.classes = extractClasses(tree, pre.sourceText, "csharp");
  pre.postExtract?.(a, src);
  return a;
}

describe("C# 14 extension blocks", () => {
  it("rewrites each header into a nested class of the same length, keeping every line", () => {
    const out = rewriteExtensionBlocks(SRC)!;
    expect(out.sourceText.length).toBe(SRC.length);
    expect(out.sourceText.split("\n").length).toBe(SRC.split("\n").length);
    expect(out.sourceText).toContain("    class __ext0      \n");
    expect(out.blocks).toEqual([
      { name: "__ext0", line: 4, receiverType: "Car", receiverName: "car" },
      { name: "__ext1", line: 10, receiverType: "List<T>", receiverName: "items" },
    ]);
  });

  it("gives each member the block's parameter as its receiver, on the enclosing class, with no phantom `extension`", async () => {
    const a = await analyzed(SRC);
    expect(a.classes.map((c) => c.name)).toEqual(["CarExtensions"]);
    const methods = a.classes[0]!.methods;
    expect(methods.map((m) => m.name).sort()).toEqual(["Build", "Fastest", "Honk", "Wash"]);
    const honk = methods.find((m) => m.name === "Honk")!;
    expect(honk.params).toEqual([{ name: "car", type: "Car", defaultValue: null, isReceiver: true }]);
    expect(honk.line).toBe(7);
    expect(honk.calls.map((c) => c.name)).toEqual(["Horn.Sound"]);
    expect(methods.find((m) => m.name === "Build")!.params[0]).toMatchObject({ type: "Car", isReceiver: true });
    expect(methods.find((m) => m.name === "Fastest")!.params[0]).toMatchObject({ name: "items", type: "List<T>", isReceiver: true });
    // The classic form is untouched.
    expect(methods.find((m) => m.name === "Wash")!.params[0]).toMatchObject({ name: "car", isReceiver: true });
  });

  it("leaves a method or a call named `extension` alone", () => {
    expect(rewriteExtensionBlocks(`class Garage {
    public void extension(Car car) { }
    void Run() { extension(car); }
}`)).toBeNull();
  });
});
