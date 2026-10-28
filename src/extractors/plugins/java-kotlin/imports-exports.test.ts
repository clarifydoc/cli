import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinImportExportExtractor } from "./imports-exports.js";

describe("Kotlin import aliases", () => {
  it("binds the alias and maps it to the declared name", async () => {
    const src = `package app

import league.util.formatScore as fmt
import garage.Mechanic as Fixer
import garage.Wrench
import league.rules.*
`;
    const tree = await parseSource(src, "kotlin" as never, "Workshop.kt");
    const out = new JavaKotlinImportExportExtractor().extractImports(tree, src).map((i) => [i.source, i.specifiers, i.aliases]);
    expect(out).toEqual([
      ["league.util.formatScore", ["fmt"], { fmt: "formatScore" }],
      ["garage.Mechanic", ["Fixer"], { Fixer: "Mechanic" }],
      ["garage.Wrench", ["Wrench"], undefined],
      ["league.rules", [], undefined],
    ]);
  });
});
