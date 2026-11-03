import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";
import "../extractors/registry.js"; // side effect: registers tree-sitter grammars
import { getGrammarParser, isBaselineOnlyGrammar, largestFunctionBody, parseSource } from "./parser-manager.js";

const require = createRequire(import.meta.url);
const grammarBytes = (pkg: string, wasm: string) => readFileSync(require.resolve(`${pkg}/${wasm}`));

const MB = 1024 * 1024;
const maxRssBytes = () => process.resourceUsage().maxRSS * 1024;

describe("grammars with an outsized lexer", () => {
  it("reads the largest function body of a grammar binary", () => {
    expect(largestFunctionBody(grammarBytes("tree-sitter-swift", "tree-sitter-swift.wasm"))).toBeGreaterThan(300_000);
    expect(largestFunctionBody(grammarBytes("tree-sitter-julia", "tree-sitter-julia.wasm"))).toBeGreaterThan(300_000);
    expect(largestFunctionBody(grammarBytes("tree-sitter-python", "tree-sitter-python.wasm"))).toBeLessThan(150_000);
    expect(largestFunctionBody(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toBe(0);
    expect(largestFunctionBody(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 10, 0xff]))).toBe(0);
  });

  // V8's optimizing compiler held 3.5 GB (Swift) and 3 GB (Julia) to tier one of these lexers up, which
  // happened within the first line parsed — a four-line file cost a 3.5 GB peak. The compile runs in the
  // background for about half a second, so the test waits past it before reading the peak.
  it("parses Swift and Julia without the optimizing compiler's multi-gigabyte peak", async () => {
    const before = maxRssBytes();
    const swift = Array.from({ length: 40 }, (_, i) => `struct Car${i} {\n  func drive() { park(${i}) }\n  func park(_ gear: Int) {}\n}\n`).join("");
    const julia = Array.from({ length: 40 }, (_, i) => `module Garage${i}\nfunction drive(car)\n    park(car, ${i})\nend\nend\n`).join("");

    const swiftParser = await getGrammarParser("swift");
    const swiftTree = swiftParser.parse(swift)!;
    expect(swiftTree.rootNode.hasError).toBe(false);
    swiftTree.delete();
    const juliaTree = await parseSource(julia, "julia" as never, "garage.jl");
    expect(juliaTree.rootNode.hasError).toBe(false);
    juliaTree.delete();

    expect(isBaselineOnlyGrammar("swift")).toBe(true);
    expect(isBaselineOnlyGrammar("julia")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((maxRssBytes() - before) / MB).toBeLessThan(500);
  }, 20_000);
});
