import { describe, it, expect } from "vitest";
import { headSpan, headTailRule } from "./control-flow-regex.js";

/** The statement rules whose tail the scanner reads by hand, as the plugins write them. */
const RULES = [
  /^\}?\s*else\s+if\b\s*\(?\s*(.*?)\s*\)?\s*\{?\s*$/,
  /^if\b\s*\(?\s*(.*?)\s*\)?\s*\{?\s*$/,
  /^(?:while|until)\b\s*\(?\s*(.*?)\s*\)?\s*\{?\s*$/,
  /^(?:for|foreach)\b\s*\(?\s*(.*?)\s*\)?\s*\{?\s*$/,
  /^(?:switch|match|select)\b\s*\(?\s*(.*?)\s*\)?\s*\{?\s*$/,
];

const LINES = [
  "if (club.relegated) {",
  "if club.relegated {",
  "if (club.relegated)",
  "if",
  "if (",
  "if {",
  "if ()",
  "if () {",
  "if ( ) { ",
  "if(a(b) > 0) {",
  "if ((a)) {",
  "if (a)) {",
  "if (a) ) {",
  "if (a) { {",
  "if (a) {{",
  "if (a) { )",
  "if a { b } else {",
  "if err := league.Save(ctx,                                        ); err != nil {",
  "if   \t (  x  )  \t {",
  "if (x) {",
  "iffy(x) {",
  "ifx",
  "} else if (points > 3) {",
  "}else  if points > 3 {",
  "else if (x)",
  "else iffy",
  "while (true) {",
  "until done",
  "for (const player of squad) {",
  "foreach ($clubs as $club) {",
  "for i := 0; i < 10; i++ {",
  "for {",
  "for",
  "switch (kind) {",
  "match season {",
  "select {",
  "switch x := v.(type) {",
  "if (a) { return }",
  "if (a) )",
  "if (a) ) )",
  "if ) {",
  "if ){",
  "if ( ( {",
];

describe("statement heads read by hand", () => {
  it("takes every rule that ends with the shared tail", () => {
    for (const re of RULES) expect(headTailRule(re), re.source).not.toBeNull();
    expect(headTailRule(/^try\b/)).toBeNull();
    expect(headTailRule(/^guard\b\s*(.*?)\s*else\s*\{?\s*$/)).toBeNull();
    // A group in the keyword part would renumber the head.
    expect(headTailRule(/^(if|unless)\b\s*\(?\s*(.*?)\s*\)?\s*\{?\s*$/)).toBeNull();
  });

  it("reads the span the pattern captures", () => {
    const check = (line: string) => {
      for (const re of RULES) {
        const hit = new RegExp(re.source, "d").exec(line);
        const got = headSpan(line, headTailRule(re)!);
        expect(got, `${re.source} on ${JSON.stringify(line)}`).toEqual(hit ? hit.indices![1] : null);
      }
    };
    for (const line of LINES) check(line);
    // Every short line over the characters the tail tells apart.
    const alphabet = ["a", " ", "(", ")", "{", "\t"];
    const words = ["if", "} else if", "for", "while", "switch"];
    const grow = (prefix: string, left: number) => {
      check(prefix);
      if (left > 0) for (const c of alphabet) grow(prefix + c, left - 1);
    };
    for (const w of words) grow(w, 5);
  });

  it("stays linear on a long run of spaces", () => {
    const line = `if (league.find(${" ".repeat(20000)}) == nil) {`;
    const started = Date.now();
    const at = headSpan(line, headTailRule(RULES[1]!)!)!;
    expect(line.slice(at[0], at[1])).toBe(`league.find(${" ".repeat(20000)}) == nil`);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
