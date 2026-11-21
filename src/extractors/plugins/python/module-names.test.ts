import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractPythonModuleNames } from "./module-names.js";
import { extractJsModuleNames } from "../javascript/module-names.js";

describe("module-level names and the lines each owns", () => {
  it("Python: an assignment owns its comment above and the blank lines below; functions and imports bind none", async () => {
    const src = [
      "import os", // 1
      "", // 2
      "# the season limit", // 3
      "SEASON_LIMIT = 38", // 4
      "", // 5
      "league_router = Router(", // 6
      '    prefix="/clubs",', // 7
      ")", // 8
      "", // 9
      "def table():", // 10
      "    return 1", // 11
      "",
      "A, B = 1, 2",
      "Car.speed = 3",
    ].join("\n");
    const tree = await parseSource(src, "python" as never, "x.py");
    expect(extractPythonModuleNames(tree!)).toEqual([
      { name: "SEASON_LIMIT", line: 3, endLine: 5 },
      { name: "league_router", line: 6, endLine: 9 },
      { name: "A", line: 13, endLine: 13 },
      { name: "B", line: 13, endLine: 13 },
    ]);
  });

  it("a comment trailing the statement above stays with it", async () => {
    const tree = await parseSource(["A = 1  # note", "B = 2", ""].join("\n"), "python" as never, "x.py");
    expect(extractPythonModuleNames(tree!)).toEqual([
      { name: "A", line: 1, endLine: 1 },
      { name: "B", line: 2, endLine: 2 },
    ]);
  });

  it("TypeScript: const/let/var, exported or destructured, own their lines; a function declaration binds none", async () => {
    const src = ["import { x } from './x';", "", "export const LIMIT = 5;", "", "const { a, b: c, d = 1, e: f = DEFAULT } = cfg;", "function g() {}", "let late: number;"].join("\n");
    const tree = await parseSource(src, "typescript" as never, "x.ts");
    expect(extractJsModuleNames(tree!)).toEqual([
      { name: "LIMIT", line: 3, endLine: 4 },
      { name: "a", line: 5, endLine: 5 },
      { name: "c", line: 5, endLine: 5 },
      { name: "d", line: 5, endLine: 5 },
      { name: "f", line: 5, endLine: 5 },
      { name: "late", line: 7, endLine: 7 },
    ]);
  });

  it("the last name ends at its own statement: a component's template below the script is not its lines", async () => {
    // A single-file component's script as the parser sees it: the template after it is blanked out.
    const src = ["", "  let title = 'Club';", "", "", "", "", ""].join("\n");
    const tree = await parseSource(src, "typescript" as never, "x.ts");
    expect(extractJsModuleNames(tree!)).toEqual([{ name: "title", line: 2, endLine: 2 }]);
  });
});
