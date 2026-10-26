import { describe, it, expect } from "vitest";
import { attachDocComments } from "./doc-comments.js";
import { C_STYLE_DOCS, HASH_DOCS, PASCAL_DOCS, PYTHON_DOCS } from "../extractors/shared/doc-comment-specs.js";
import { createEmptyAnalysis, type FunctionInfo, type Language } from "../types/analysis.js";

const fn = (name: string, line: number): FunctionInfo =>
  ({ name, line, endLine: line + 2, params: [], calls: [], decorators: [], isAsync: false, isExported: true, returnType: null }) as FunctionInfo;

function docs(language: Language, source: string, spec: typeof C_STYLE_DOCS, at: Array<[string, number]>, classes: Array<[string, number]> = []) {
  const a = createEmptyAnalysis("src/league.x", language);
  a.functions = at.map(([n, l]) => fn(n, l));
  a.classes = classes.map(([name, line]) => ({ name, line, endLine: line + 5, methods: [], properties: [], decorators: [], extends: null, implements: [] })) as never;
  attachDocComments(a, source, spec);
  return { fns: Object.fromEntries(a.functions.map((f) => [f.name, f.doc])), classes: Object.fromEntries(a.classes.map((c) => [c.name, c.doc])) };
}

describe("attachDocComments", () => {
  it("reads a JSDoc block's first sentence, past decorators, and drops its tags", () => {
    const src = [
      "/**",
      " * Signs a player to the club. Checks the contract first.",
      " * @param player the player",
      " */",
      "@Post()",
      "export function signPlayer(player) {}",
      "",
      "// Points for a win.",
      "const WIN = 3;",
      "function table() {}",
    ].join("\n");
    expect(docs("typescript", src, C_STYLE_DOCS, [["signPlayer", 6], ["table", 10]]).fns).toEqual({ signPlayer: "Signs a player to the club.", table: undefined });
  });

  it("reads line comments, C# summaries and single-line blocks", () => {
    const cs = ["/// <summary>", "/// Books a pitch for a match.", "/// </summary>", "/// <param name=\"id\">The match.</param>", "[HttpPost]", "public void Book(int id) {}"].join("\n");
    expect(docs("csharp", cs, C_STYLE_DOCS, [["Book", 6]]).fns.Book).toBe("Books a pitch for a match.");
    const go = ["// Transfer moves a player between clubs", "// and records the fee.", "func Transfer() {}"].join("\n");
    expect(docs("go", go, C_STYLE_DOCS, [["Transfer", 3]]).fns.Transfer).toBe("Transfer moves a player between clubs and records the fee.");
    expect(docs("c", "/* Kick-off time of the match. */\nint kickoff(void) {}", C_STYLE_DOCS, [["kickoff", 2]]).fns.kickoff).toBe("Kick-off time of the match.");
  });

  it("reads a Python docstring, one line or several, for functions and classes", () => {
    const src = [
      "class Squad:",
      '    """The players a club fields this season."""',
      "",
      "    @property",
      "    def size(",
      "        self,",
      "    ) -> int:",
      '        """',
      "        How many players are registered.",
      "",
      "        Loaned players count.",
      '        """',
      "        return 1",
    ].join("\n");
    expect(docs("python", src, PYTHON_DOCS, [["size", 5]], [["Squad", 1]])).toEqual({ fns: { size: "How many players are registered." }, classes: { Squad: "The players a club fields this season." } });
  });

  it("skips licences, directives and commented-out code", () => {
    const src = [
      "// Copyright 2026 The League Authors. All rights reserved.",
      "function a() {}",
      "// eslint-disable-next-line no-console",
      "function b() {}",
      "// const old = fetchTable();",
      "function c() {}",
    ].join("\n");
    expect(docs("javascript", src, C_STYLE_DOCS, [["a", 2], ["b", 4], ["c", 6]]).fns).toEqual({ a: undefined, b: undefined, c: undefined });
    expect(docs("ruby", "# frozen_string_literal: true\nclass Club; end", HASH_DOCS, [], [["Club", 2]]).classes.Club).toBeUndefined();
  });

  it("reads Pascal brace comments and caps a long first sentence", () => {
    const long = "Recalculates ".concat("the league table ".repeat(20));
    const src = [`{ ${long} }`, "procedure Recalculate;"].join("\n");
    const doc = docs("pascal", src, PASCAL_DOCS, [["Recalculate", 2]]).fns.Recalculate!;
    expect(doc.length).toBeLessThanOrEqual(200);
    expect(doc.endsWith("…")).toBe(true);
  });
});
