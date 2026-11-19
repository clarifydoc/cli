import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PythonDataSourceExtractor } from "./data-sources.js";

describe("Python api calls carry a column", () => {
  it("points a requests call at its start, after a non-ASCII prefix too", async () => {
    const src = `import requests

def load():
    requests.get("/api/clubs")
    s = "é🚗"; requests.post("/api/players")
`;
    const tree = await parseSource(src, "python" as never, "x.py");
    const calls = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(calls.map((d) => [d.line, d.column])).toEqual([[4, 4], [5, 15]]);
  });
});
