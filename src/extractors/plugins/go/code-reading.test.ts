import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const analyze = (src: string) => extractWithRegex(src, "league/fixtures.go", "go");
const fn = (src: string, name: string) => {
  const a = analyze(src);
  return [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((f) => f.name === name)!;
};
const callNames = (src: string, name: string) => fn(src, name).calls.map((c) => c.name);

describe("Go source is read as code before braces are counted and calls read", () => {
  it("ends a function at its own brace, past braces in strings, runes and raw strings", () => {
    const src = [
      "package league", // 1
      "", // 2
      "func Render(m *Match) string {", // 3
      '\topen := "{"', // 4
      "\tclose := '}'", // 5
      "\ttpl := `{", // 6
      '\t  "club": "}}"', // 7
      "\t`", // 8
      "\treturn lineup(open, close, tpl)", // 9
      "}", // 10
      "", // 11
      "func Score() int { return tally() }", // 12
    ].join("\n");
    expect(fn(src, "Render").endLine).toBe(10);
    expect(callNames(src, "Render")).toContain("lineup");
    expect(fn(src, "Score").endLine).toBe(12);
  });

  it("reads no calls out of a raw string or a block comment", () => {
    const src = [
      "package league",
      "func Table(db *DB) {",
      "\tdb.Query(`SELECT COALESCE(goals, 0)",
      "\t  FROM standings(season)`)",
      "\t/* rebuild(table) */",
      "\tdb.Close()",
      "}",
    ].join("\n");
    const names = callNames(src, "Table");
    expect(names).toContain("db.Query");
    expect(names).not.toContain("COALESCE");
    expect(names).not.toContain("standings");
    expect(names).not.toContain("rebuild");
  });

  it("does not take a function literal's `func` for a call", () => {
    const src = ["package league", "func TestFixtures(t *T) {", '\tt.Run("home", func(t *T) {', "\t\tkickOff()", "\t})", "}"].join("\n");
    const names = callNames(src, "TestFixtures");
    expect(names).not.toContain("func");
    expect(names).toEqual(expect.arrayContaining(["t.Run", "kickOff"]));
  });

  it("finds no function in a commented-out block or a code template", () => {
    const src = [
      "package league",
      "/*",
      "func Retired() {}",
      "*/",
      "const tpl = `",
      "func Generated() {}",
      "`",
      "func Active() {}",
    ].join("\n");
    const names = analyze(src).functions.map((f) => f.name);
    expect(names).toEqual(["Active"]);
  });

  it("records a member call whose name is a keyword in some language", () => {
    const src = ["package league", "func Filter(cond Cond) Cond {", "\treturn cond.And(cond.Or(a, b))", "}"].join("\n");
    expect(callNames(src, "Filter")).toEqual(expect.arrayContaining(["cond.And", "cond.Or"]));
  });

  it("names a method called on a call's result as the chain", () => {
    const src = [
      "package league",
      "func Close(ctx Context) {",
      "\tgraceful.GetManager().Shutdown(ctx)",
      "\tnewTransferService().Register(ctx, 3)",
      '\tgitcmd.NewCommand("fetch").AddArguments(x).Run(ctx)',
      "}",
    ].join("\n");
    expect(callNames(src, "Close")).toEqual(
      expect.arrayContaining(["graceful.GetManager().Shutdown", "newTransferService().Register", "gitcmd.NewCommand().AddArguments", "gitcmd.NewCommand().AddArguments().Run"]),
    );
  });

  it("serves no route a comment holds", () => {
    const src = [
      "package league",
      "func Routes(r *gin.RouterGroup) {",
      '\tr.GET("/clubs", ListClubs)',
      "\t/*",
      '\tr.DELETE("/clubs/:id", DeleteClub)',
      "\t*/",
      "}",
    ].join("\n");
    expect(analyze(src).routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /clubs"]);
  });
});
