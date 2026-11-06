import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractPythonModuleValues } from "./module-values.js";
import { extractPythonNameAliases } from "./type-aliases.js";

const parse = (src: string) => parseSource(src, "python" as never, "x.py");

describe("Python `global x`: a function's assignment binds the module variable", () => {
  it("a module string a function rebinds through `global` is no fixed value", async () => {
    const tree = await parse(
      ['CLUBS_URL = "/api/v2/clubs"', 'PLAYERS_URL = "/api/v2/players"', "", "def switch_season():", "    global CLUBS_URL", '    CLUBS_URL = "/api/v3/clubs"', ""].join("\n"),
    );
    expect(extractPythonModuleValues(tree!)).toEqual({ PLAYERS_URL: "/api/v2/players" });
  });

  it("a module alias a function rebinds through `global` is no alias", async () => {
    const tree = await parse(
      ["def attrs(): ...", "def other(): ...", "club = attrs", "squad = attrs", "", "def retarget():", "    global club", "    club = other", ""].join("\n"),
    );
    expect(extractPythonNameAliases(tree!).map((a) => a.name)).toEqual(["squad"]);
  });
});
