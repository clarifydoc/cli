import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const analyze = (src: string) => extractWithRegex(src, "src/league.rs", "rust");
const fn = (src: string, name: string) => {
  const a = analyze(src);
  return [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((f) => f.name === name)!;
};
const callNames = (src: string, name: string) => fn(src, name).calls.map((c) => c.name);

describe("Rust source is read as code before braces are counted and calls read", () => {
  it("ends a function at its own brace, past raw strings, strings across lines, chars and lifetimes", () => {
    const src = [
      "struct Club;", // 1
      "impl Club {", // 2
      "    fn render<'a>(&self, name: &'a str) -> &'a str {", // 3
      '        let tpl = r#"{ "club": "}" }"#;', // 4
      "        let open = '{';", // 5
      '        let note = "multi {', // 6
      '            line";', // 7
      "        lineup(tpl, open, note)", // 8
      "    }", // 9
      "    fn score(&self) -> u8 { tally() }", // 10
      "}", // 11
    ].join("\n");
    expect(fn(src, "render").endLine).toBe(9);
    expect(callNames(src, "render")).toContain("lineup");
    const club = analyze(src).classes.find((c) => c.name === "Club")!;
    expect(club.methods.map((m) => m.name)).toEqual(["render", "score"]);
  });

  it("reads no call out of a keyword, an attribute or a closure trait", () => {
    const src = [
      "fn table(rows: Vec<Row>) -> impl Fn(u8) -> u8 {",
      "    let (home, away) = split(rows);",
      "    #[cfg(test)]",
      "    let total = match (home, away) { _ => 0 };",
      "    for x in (0..total) { count(x); }",
      "    move |g| g",
      "}",
    ].join("\n");
    const names = callNames(src, "table");
    expect(names).toEqual(expect.arrayContaining(["split", "count"]));
    for (const k of ["let", "match", "cfg", "in", "Fn"]) expect(names).not.toContain(k);
  });

  it("reads a turbofish call as the call it is", () => {
    const src = ["fn load(body: &str) {", "    let n = body.parse::<u32>();", "    let v = Vec::<u8>::new();", "    decode::<Match, Vec<u8>>(body);", "}"].join("\n");
    expect(callNames(src, "load")).toEqual(expect.arrayContaining(["body.parse", "Vec.new", "decode"]));
  });

  it("names a method called on a call's result as the chain", () => {
    const src = ["fn sign(id: u32) {", "    Club::new(id).register(3);", "    transfer_service().complete();", "}"].join("\n");
    expect(callNames(src, "sign")).toEqual(expect.arrayContaining(["Club.new().register", "transfer_service().complete"]));
  });

  it("finds no function in a comment or a string", () => {
    const src = ["/*", "fn retired() {}", "*/", 'const TPL: &str = "', "fn generated() {}", '";', "fn active() {}"].join("\n");
    expect(analyze(src).functions.map((f) => f.name)).toEqual(["active"]);
  });
});
