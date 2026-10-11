import { describe, expect, it } from "vitest";
import { escapeRegex, stripAngleGroups, trimTrailingSlashes } from "./path-utils.js";
import { asDoubleQuotedLiteral } from "./sql-string-sources.js";

describe("escapeRegex", () => {
  it("escapes every metacharacter, backslash included", () => {
    const raw = String.raw`a.b*c+d?e^f$g{h}i(j)k|l[m]n\o`;
    expect(new RegExp(`^${escapeRegex(raw)}$`).test(raw)).toBe(true);
    expect(new RegExp(`^${escapeRegex("$ctx")}$`).test("xctx")).toBe(false);
  });
});

describe("trimTrailingSlashes", () => {
  it("drops only the trailing run", () => {
    expect(trimTrailingSlashes("a/b//")).toBe("a/b");
    expect(trimTrailingSlashes("/a/b")).toBe("/a/b");
    expect(trimTrailingSlashes("///")).toBe("");
    expect(trimTrailingSlashes("")).toBe("");
  });
});

describe("stripAngleGroups", () => {
  it("removes nested generic arguments and keeps the rest verbatim", () => {
    expect(stripAngleGroups("Dictionary<string, List<int>>")).toBe("Dictionary");
    expect(stripAngleGroups("Map<K,V>.Entry<X>")).toBe("Map.Entry");
    expect(stripAngleGroups("plain")).toBe("plain");
    expect(stripAngleGroups("Open<never closed")).toBe("Open");
    expect(stripAngleGroups("a > b")).toBe("a > b");
  });
});

describe("asDoubleQuotedLiteral", () => {
  it("escapes quotes and backslashes so the literal reads back whole", () => {
    expect(asDoubleQuotedLiteral(String.raw`SELECT "x" FROM t WHERE p = '\'`)).toBe(String.raw`"SELECT \"x\" FROM t WHERE p = '\\'"`);
    const literal = /^"((?:[^"\\]|\\.)*)"$/;
    expect(literal.test(asDoubleQuotedLiteral(String.raw`a\"b`))).toBe(true);
  });
});
