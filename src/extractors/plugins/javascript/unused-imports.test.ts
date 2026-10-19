import { describe, expect, it } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractImports } from "../../imports-exports/index.js";

async function unused(src: string, language: "typescript" | "javascript" = "typescript", embedded = false) {
  const tree = await parseSource(src, language as never, "src/x.tsx");
  return extractImports(tree, src, language as never, embedded)
    .filter((i) => i.unused)
    .map((i) => `${i.source}: ${i.unused!.join(",")}`);
}

describe("unused import bindings", () => {
  it("names the bindings nothing in the file mentions, by their local name", async () => {
    expect(await unused(`import { a, b as bee, c } from "./m";
import Def from "./d";
import * as ns from "./ns";
import "./side-effect";
console.log(a, ns.x);
const o = { c: 1 }; // c is a key here — still counted as written: a mention errs toward silence
`)).toEqual(["./m: bee", "./d: Def"]);
  });

  it("does not take a property for the binding, but does take a spread", async () => {
    expect(await unused(`import { Foo, Bar } from "./m";
x.Foo();
const y = [...Bar];
`)).toEqual(["./m: Foo"]);
  });

  it("counts JSX, types, re-exports and the React of the classic runtime", async () => {
    expect(await unused(`import React from "react";
import { Card } from "./Card";
import type { Props } from "./types";
import { helper } from "./h";
export { helper };
export function View(p: Props) { return <Card />; }
`)).toEqual([]);
  });

  it("says nothing for a script block whose template may use the imports", async () => {
    expect(await unused(`import Child from "./Child.vue";\n`, "typescript", true)).toEqual([]);
    expect(await unused(`import Child from "./Child.vue";\n`, "typescript")).toEqual(["./Child.vue: Child"]);
  });

  it("finds each statement after non-ASCII text", async () => {
    expect(await unused(`// Grüße — ✓ 😀
import { used, unusedOne } from "./m";
used();
`)).toEqual(["./m: unusedOne"]);
  });
});
