import { describe, it, expect, vi } from "vitest";
import { Parser } from "web-tree-sitter";
import "../extractors/registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "./parser-manager.js";

describe("parser start-up under concurrency", () => {
  it("parses every file of a first batch that starts at once, sharing one runtime init and one grammar load", async () => {
    // The first parses of a run: files analysed concurrently all ask for the runtime and their grammar together.
    const sources: Array<[string, string, string]> = [];
    for (let i = 0; i < 6; i++) {
      sources.push([`class Club${i}:\n    name = "c${i}"\n`, "python", `league/club${i}.py`]);
      sources.push([`export class Car${i} { drive() { return ${i}; } }\n`, "typescript", `garage/car${i}.ts`]);
    }
    // A second runtime init re-instantiates the WASM module under grammars already loaded:
    // their parser then refuses them ("Incompatible language version 0") and the file fell back to regex.
    const init = vi.spyOn(Parser, "init");
    const trees = await Promise.all(sources.map(([text, lang, path]) => parseSource(text, lang as never, path)));
    expect(init.mock.calls.length).toBeLessThanOrEqual(1);
    expect(trees.map((t) => t.rootNode.hasError)).toEqual(sources.map(() => false));
    expect(trees.map((t) => t.rootNode.namedChild(0)?.type)).toEqual(sources.map(([, lang]) => (lang === "python" ? "class_definition" : "export_statement")));
  });
});
