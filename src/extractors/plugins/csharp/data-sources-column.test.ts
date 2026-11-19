import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { CSharpDataSourceExtractor } from "./data-sources.js";

async function callsOf(src: string) {
  const tree = await parseSource(src, "csharp" as any, "H.cs");
  return new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

describe("C# api calls carry a column", () => {
  it("points an HttpClient call at its start, after a non-ASCII prefix too", async () => {
    const calls = await callsOf(`using System.Net.Http;
class H {
  async Task M(HttpClient http) {
    var s = "é🚗"; await http.GetAsync("/api/clubs");
  }
}`);
    expect(calls.map((d) => [d.line, d.column])).toEqual([[4, 25]]);
  });
});
