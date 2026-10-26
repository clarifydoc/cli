import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const names = (src: string) => extractWithRegex(src, "src/League/Score.hs", "haskell").functions.map((f) => [f.name, f.line]);

describe("Haskell infix definitions", () => {
  it("names an operator or a backticked function defined infix, once", () => {
    const src = [
      "module League.Score where",
      "",
      "a <+> b = Score (goals a + goals b)",
      "",
      "x `beats` y = points x > points y",
      "",
      "(<->) a b = Score (goals a - goals b)",
      "",
      "Nothing |> f = Nothing",
      "Just x |> f = f x",
      "",
      "(Club a) <=> (Club b) = compare a b",
    ].join("\n");
    expect(names(src)).toEqual([["<+>", 3], ["beats", 5], ["<->", 7], ["<=>", 12]]);
  });

  it("takes an operator's signature, and does not count its equation again", () => {
    const src = [
      "(<+>) :: Score -> Score -> Score",
      "a <+> b = Score (goals a + goals b)",
      "",
      "beats :: Club -> Club -> Bool",
      "x `beats` y = points x > points y",
    ].join("\n");
    expect(names(src)).toEqual([["<+>", 1], ["beats", 4]]);
  });

  it("reads no definition from ordinary equations, comparisons or instances", () => {
    const src = [
      "table :: [Club] -> [Club]",
      "table = sortOn points",
      "main = print (a == b)",
      "isLeader c = rank c == 1",
      "data Club = Club { name :: String }",
      "instance Eq Club where",
      "  a == b = name a == name b",
    ].join("\n");
    expect(names(src)).toEqual([["table", 1]]);
  });
});
