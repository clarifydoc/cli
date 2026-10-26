import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const analyze = (src: string) => extractWithRegex(src, "Sources/League/Club.swift", "swift");
const all = (src: string) => {
  const a = analyze(src);
  return [...a.functions, ...a.classes.flatMap((c) => c.methods)];
};
const fn = (src: string, name: string) => all(src).find((f) => f.name === name)!;

describe("Swift source is read as code before braces are counted and calls read", () => {
  it("ends a function at its own brace, past braces in strings and raw strings", () => {
    const src = [
      "struct Club {", // 1
      "    func render() -> String {", // 2
      '        let open = "{"', // 3
      '        let raw = #"}"#', // 4
      '        let body = """', // 5
      "        { }}", // 6
      '        """', // 7
      "        return lineup(open, raw, body)", // 8
      "    }", // 9
      "    func score() -> Int { tally() }", // 10
      "}", // 11
    ].join("\n");
    expect(fn(src, "render").endLine).toBe(9);
    expect(fn(src, "render").calls.map((c) => c.name)).toContain("lineup");
    expect(fn(src, "score").endLine).toBe(10);
  });

  it("finds no function in a string template or a comment", () => {
    const src = ["struct Gen {", '    let expanded = """', "    func generated() {}", '    """', "    /* func retired() {} */", "    func active() {}", "}"].join("\n");
    expect(all(src).map((f) => f.name)).toEqual(["active"]);
  });

  it("reads a call whose only argument is a trailing closure, not a block keyword or a type", () => {
    const src = [
      "final class MatchTests {",
      "    func testKickOff() async throws {",
      "        try await withLeague { league in",
      "            if league.ready {",
      "                DispatchQueue.main.async {",
      "                    VStack {",
      "                    }",
      "                }",
      "            }",
      "        }",
      "    }",
      "}",
    ].join("\n");
    const names = fn(src, "testKickOff").calls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["withLeague", "DispatchQueue.main.async"]));
    for (const n of ["if", "VStack", "league.ready"]) expect(names).not.toContain(n);
  });
});
