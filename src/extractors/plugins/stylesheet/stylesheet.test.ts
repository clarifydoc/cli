import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";
import { resolveImportSource } from "../../../core/import-index.js";
import type { FileAnalysis, Language } from "../../../types/analysis.js";

const analyze = (src: string, path: string, language: Language): FileAnalysis => extractWithRegex(src, path, language);
const fns = (a: FileAnalysis) => a.functions.map((f) => [f.name, f.params.map((p) => p.name + (p.defaultValue ? `=${p.defaultValue}` : "")), f.calls.map((c) => c.name)]);

describe("SCSS", () => {
  const a = analyze([
    '@use "sass:math";',
    '@use "../theme/colors" as c;',
    '@use "mixins";',
    '@forward "buttons";',
    '@import "legacy";',
    "",
    "@function spacing($n: 1) {",
    "  @return math.div($n * 8px, 2) + rem-size(4);",
    "}",
    "@mixin card($pad: spacing(2)) {",
    "  padding: $pad;",
    "  background: rgba(c.$bg, 0.8);",
    "  color: c.shade($fg, 10%);",
    "  @include mixins.shadow(2);",
    "}",
    ".panel {",
    "  @include card;",
    "  width: calc(100% - #{spacing(3)});",
    "}",
  ].join("\n"), "src/components/_card.scss", "scss");

  it("reads mixins and functions with their parameters and uses", () => {
    expect(fns(a)).toEqual([
      ["<setup>", [], ["card", "spacing"]],
      ["spacing", ["n=1"], ["rem-size"]],
      ["card", ["pad=spacing(2)"], ["c.shade", "mixins.shadow"]],
    ]);
  });

  it("reads @use / @forward / @import as imports, the namespace as the specifier", () => {
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([
      ["../theme/colors", ["c"]], ["./mixins", ["mixins"]], ["./buttons", ["buttons"]], ["./legacy", []],
    ]);
  });
});

describe("Sass (indented) and Less", () => {
  it("reads the indented syntax's =mixin and +include", () => {
    const a = analyze(["@use 'theme'", "=button($color)", "  background: $color", "  +rounded(4px)", ".save", "  +button(green)"].join("\n"), "src/_buttons.sass", "sass");
    expect(fns(a)).toEqual([["<setup>", [], ["button"]], ["button", ["color"], ["rounded"]]]);
    expect(a.imports.map((i) => i.source)).toEqual(["./theme"]);
  });

  it("reads Less mixins with guards and their calls", () => {
    const a = analyze([
      '@import (reference) "variables";',
      ".bordered(@width: 2px; @style: solid) when (@width > 0) {",
      "  border: @width @style black;",
      "  .rounded(4px);",
      "}",
      "#header {",
      "  .bordered(4px);",
      "  .clearfix;",
      "}",
    ].join("\n"), "styles/main.less", "less");
    expect(fns(a)).toEqual([["<setup>", [], ["bordered", "clearfix"]], ["bordered", ["width=2px", "style=solid"], ["rounded"]]]);
    expect(a.imports.map((i) => i.source)).toEqual(["./variables.less"]);
  });
});

describe("Sass partials resolve", () => {
  const files = ["src/app.scss", "src/_buttons.scss", "src/theme/_index.scss", "src/theme/_colors.scss"];
  const analyses = files.map((filePath) => ({ filePath, language: "scss" }) as FileAnalysis);

  it("through the linker's path map", () => {
    const map = buildFilePathMap(analyses);
    expect(resolveTarget("./buttons", "src/app.scss", map)).toBe("src/_buttons.scss");
    expect(resolveTarget("./theme", "src/app.scss", map)).toBe("src/theme/_index.scss");
    expect(resolveTarget("../theme/colors", "src/components/x.scss", map)).toBe("src/theme/_colors.scss");
  });

  it("through the import index", () => {
    const known = new Set(files);
    expect(resolveImportSource("src/app.scss", "./buttons", known)).toBe("src/_buttons.scss");
    expect(resolveImportSource("src/app.scss", "./theme", known)).toBe("src/theme/_index.scss");
  });
});
