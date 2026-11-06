import { describe, it, expect } from "vitest";
import { attachDocComments, declarationHeadLine } from "./doc-comments.js";
import { C_STYLE_DOCS, HASH_DOCS, PASCAL_DOCS, PYTHON_DOCS } from "../extractors/shared/doc-comment-specs.js";
import { manifestFor } from "../extractors/registry.js";
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

  it("reads the comment above a decorator whose arguments spread over rows", () => {
    const src = [
      "/** Lists the league table. */",
      "@ApiResponse({",
      "  status: 200,",
      "})",
      "@Get('table')",
      "table() {}",
    ].join("\n");
    expect(docs("typescript", src, C_STYLE_DOCS, [["table", 6]]).fns.table).toBe("Lists the league table.");
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

describe("languages with their own comment shape", () => {
  const specOf = (l: Language) => manifestFor(l)!.docComments!;
  it("every plugin that declares none before now reads its comments", () => {
    for (const l of ["sql", "perl", "elixir", "nim", "raku", "powershell", "julia", "dlang", "vlang", "haxe", "coffeescript", "clojure", "erlang"] as Language[]) expect(manifestFor(l)?.docComments, l).toBeDefined();
  });
  it("reads SQL dashes and blocks, PowerShell help blocks, Clojure semicolons, Erlang percents and Perl hashes", () => {
    expect(docs("sql", "-- Counts the points of a club.\nCREATE FUNCTION club_points() RETURNS int AS $$ $$;", specOf("sql"), [["club_points", 2]]).fns.club_points).toBe("Counts the points of a club.");
    expect(docs("powershell", "<#\n.SYNOPSIS\nLists the cars in a garage.\n#>\nfunction Get-Car {}", specOf("powershell"), [["Get-Car", 5]]).fns["Get-Car"]).toBe("Lists the cars in a garage.");
    expect(docs("powershell", "# Lists the cars in a garage.\nfunction Get-Car {}", specOf("powershell"), [["Get-Car", 2]]).fns["Get-Car"]).toBe("Lists the cars in a garage.");
    expect(docs("clojure", ";; Ranks the clubs by points.\n(defn rank [clubs] clubs)", specOf("clojure"), [["rank", 2]]).fns.rank).toBe("Ranks the clubs by points.");
    expect(docs("erlang", "%% Signs a player for the club.\nsign(P) -> P.", specOf("erlang"), [["sign", 2]]).fns.sign).toBe("Signs a player for the club.");
    expect(docs("perl", "# Returns the league table.\nsub table { }", specOf("perl"), [["table", 2]]).fns.table).toBe("Returns the league table.");
  });
});

describe("declarationHeadLine", () => {
  it("takes the attributes and doc comment of a cfg-gated variant, which otherwise reads like its twin", () => {
    const lines = [
      "/// Starts the engine of a car.",
      '#[cfg(not(target_os = "macos"))]',
      "pub fn start(car: &Car) {}",
      "",
      "/// Starts the engine of a car.",
      '#[cfg(target_os = "macos")]',
      "pub fn start(car: &Car) {}",
    ];
    const item = { decorators: ['cfg(target_os = "macos")'], doc: "Starts the engine of a car." };
    expect(declarationHeadLine(lines, 3, C_STYLE_DOCS, item)).toBe(1);
    expect(declarationHeadLine(lines, 7, C_STYLE_DOCS, item)).toBe(5);
  });

  it("leaves a comment that is not the item's doc, and stops at a blank line", () => {
    const lines = ["// TODO: rename the garage.", "@Get()", "park() {}", "", "/** Washes it. */", "", "wash() {}"];
    expect(declarationHeadLine(lines, 3, C_STYLE_DOCS, { decorators: ["Get()"] })).toBe(2);
    expect(declarationHeadLine(lines, 7, C_STYLE_DOCS, { doc: "Washes it." })).toBe(7);
  });

  it("reads a decorator the language shape does not know by the name the item lists", () => {
    const lines = ["#[tokio::main]", "async fn main() {}"];
    expect(declarationHeadLine(lines, 2, { line: ["//"] }, { decorators: ["tokio::main"] })).toBe(1);
    expect(declarationHeadLine(lines, 2, { line: ["//"] }, {})).toBe(2);
  });
});

describe("comment lanes of the script and lisp-family languages", () => {
  const lane = (language: Language, source: string, name: string, line: number, kind: "fn" | "class" = "fn") => {
    const spec = manifestFor(language)!.docComments!;
    expect(spec, `${language} has docComments`).toBeDefined();
    const r = docs(language, source, spec, kind === "fn" ? [[name, line]] : [], kind === "class" ? [[name, line]] : []);
    return kind === "fn" ? r.fns[name] : r.classes[name];
  };

  it("reads an Elixir @doc / @moduledoc heredoc past @spec and @impl, and no other heredoc", () => {
    const src = [
      "defmodule League.Table do",
      '  @moduledoc """',
      "  Ranks the clubs of a league. Ties go to goal difference.",
      '  """',
      "",
      '  @doc """',
      "  Adds the points of one match.",
      "",
      "  ## Examples",
      '  """',
      "  @spec add(integer) :: integer",
      "  def add(points), do: points",
      "",
      '  @sample """',
      "  Not documentation here.",
      '  """',
      "  def other, do: 1",
      "end",
    ].join("\n");
    expect(lane("elixir", src, "add", 12)).toBe("Adds the points of one match.");
    expect(lane("elixir", src, "other", 17)).toBeUndefined();
    expect(lane("elixir", src, "League.Table", 1, "class")).toBe("Ranks the clubs of a league.");
  });

  it("reads Perl POD above a sub", () => {
    const src = ["=head2 kickoff", "", "Starts the match for both clubs. Then waits.", "", "=cut", "", "sub kickoff {", "}"].join("\n");
    expect(lane("perl", src, "kickoff", 7)).toBe("Starts the match for both clubs.");
    expect(lane("perl", ["# Ends the match.", "sub whistle {", "}"].join("\n"), "whistle", 2)).toBe("Ends the match.");
  });

  it("reads `;`, `!` and batch `REM` / `::` comment lines", () => {
    expect(lane("commonlisp", [";; Scores a goal for the home club.", "(defun goal ()", ")"].join("\n"), "goal", 2)).toBe("Scores a goal for the home club.");
    expect(lane("racket", ["; Scores a goal for the away club.", "(define (goal) 1)"].join("\n"), "goal", 2)).toBe("Scores a goal for the away club.");
    expect(lane("fortran", ["! Adds up the points of a squad.", "function total(p)"].join("\n"), "total", 2)).toBe("Adds up the points of a squad.");
    expect(lane("autohotkey", ["; Opens the club roster window.", "OpenRoster() {", "}"].join("\n"), "OpenRoster", 2)).toBe("Opens the club roster window.");
    expect(lane("batch", ["REM Builds the match report.", "rem and ships it.", ":build", "echo x"].join("\n"), "build", 3)).toBe("Builds the match report.");
    expect(lane("batch", [":: Cleans the pitch folder.", ":clean"].join("\n"), "clean", 2)).toBe("Cleans the pitch folder.");
  });
});
