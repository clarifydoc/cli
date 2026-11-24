import { describe, expect, it } from "vitest";
import { requiredLiterals } from "./regex-base.js";

describe("requiredLiterals", () => {
  it("reads the mandatory top-level characters", () => {
    expect(requiredLiterals(/(?<![\w.])([a-z_]\w*)\.new\b\s*\(/)).toEqual([".new", "("]);
    expect(requiredLiterals(/^\s*render\s+:(\w+)/)).toEqual(["render", ":"]);
  });
  it("skips optional characters, groups and classes", () => {
    expect(requiredLiterals(/a?b(?:c)d[.(]e*f/)).toEqual(["b", "d", "f"]);
  });
  it("gives no gate for an alternation, a case-insensitive pattern or an unread escape", () => {
    expect(requiredLiterals(/a|b/)).toEqual([]);
    expect(requiredLiterals(/club\(/i)).toEqual([]);
    expect(requiredLiterals(new RegExp(String.fromCharCode(92) + "u0041x"))).toEqual([]);
    expect(requiredLiterals(/a{2}/)).toEqual([]);
  });
  it("never rejects a line the pattern matches", () => {
    const patterns = [/(\w+)\.(\w+)\s*\(/, /\bnew\s+([A-Z]\w*)/, /^\s*(?:def|fn)\s+(\w+)/, /club::(\w+)\(/, /a+b/, /x\.?y/];
    const lines = ["club.play(1)", "new Club()", "  def kick", "x y", "xy", "aab", "club::play(", "zzz", ""];
    for (const p of patterns) {
      for (const line of lines) {
        if (p.test(line)) for (const need of requiredLiterals(p)) expect(line.includes(need)).toBe(true);
      }
    }
  });
});
