import { describe, expect, it } from "vitest";
import { stripPythonNonCode } from "./python-tokenizer.js";

describe("stripPythonNonCode", () => {
  it("blanks strings, docstrings and comments, keeping lines and an f prefix", () => {
    const src = 'x = "pitch"  # note\ny = f"{club}"\nz = b\'ab\'\n"""\ndoc\n"""\nw = 1\n';
    expect(stripPythonNonCode(src)).toBe("x =                \ny = f        \nz =      \n   \n   \n   \nw = 1\n");
  });

  it("keeps the characters an unterminated triple quote leaves, as before", () => {
    expect(stripPythonNonCode('a = """open\nb')).toBe("a =        \nb");
  });

  it("adds a space for a backslash that runs past the end of the text", () => {
    expect(stripPythonNonCode('"ab\\')).toBe("     ");
  });

  it("leaves identifiers that end in a prefix letter alone", () => {
    expect(stripPythonNonCode("buf = 1\nur = 2")).toBe("buf = 1\nur = 2");
  });
});
