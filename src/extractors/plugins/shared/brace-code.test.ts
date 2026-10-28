import { describe, it, expect } from "vitest";
import { blankCode, type BraceLexicon } from "./brace-code.js";

const C_LIKE: BraceLexicon = {
  lineComments: ["//"],
  blockComment: { open: "/*", close: "*/", nests: true },
  strings: [{ open: '"', close: '"', escapes: true, multiline: false }],
  charLiterals: true,
};

describe("blankCode", () => {
  it("keeps every position and newline", () => {
    const src = 'a("x{") // b{\n/* c{ */ d';
    const out = blankCode(src, C_LIKE);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(2);
    expect(out.replace(/\s+/g, "")).toBe("a()d");
  });

  it("nests block comments when the language does", () => {
    expect(blankCode("/* a /* b */ c */ d", C_LIKE).trim()).toBe("d");
    expect(blankCode("/* a /* b */ c */ d", { ...C_LIKE, blockComment: { open: "/*", close: "*/" } }).trim()).toBe("c */ d");
  });

  it("blanks a character literal but not a lifetime tick", () => {
    expect(blankCode("x = '{'; y", C_LIKE)).toBe("x =    ; y");
    expect(blankCode("fn f<'a>(s: &'a str) {", C_LIKE)).toBe("fn f<'a>(s: &'a str) {");
  });

  it("keeps one-line strings on request, never multi-line ones", () => {
    const lex: BraceLexicon = { ...C_LIKE, strings: [{ open: "`", close: "`", escapes: false, multiline: true }, ...C_LIKE.strings] };
    expect(blankCode('f("a(b)")', lex, true)).toBe('f("a(b)")');
    expect(blankCode("g(`a(\nb(`)", lex, true)).toBe("g(   \n   )");
  });

  it("pads an escape on the last character past the end, as it always has", () => {
    // `"a\` at the end: the escape steps over a character that is not there, and that position is blanked too.
    expect(blankCode('kick("a\\', C_LIKE)).toBe("kick(    ");
    expect(blankCode('kick("a\\', C_LIKE)).toHaveLength(9);
  });

  it("copies code between literals as written, outside the basic plane too", () => {
    // One space a UTF-16 unit: a surrogate pair blanks to two.
    expect(blankCode('Club("⚽") /* 🏆 */ Player', C_LIKE)).toBe("Club(   )          Player");
    // A line comment runs to the `\n`, so the `\r` before it goes with it.
    expect(blankCode("Garage\r\n// lift\r\nCar", C_LIKE)).toBe("Garage\r\n        \nCar");
  });

  it("blanks a raw string the lexicon recognizes", () => {
    const lex: BraceLexicon = { ...C_LIKE, rawString: (t, i) => (t.startsWith('r#"', i) ? t.indexOf('"#', i + 3) + 2 : -1) };
    expect(blankCode('x(r#"{"#) y', lex)).toBe("x(      ) y");
  });
});
