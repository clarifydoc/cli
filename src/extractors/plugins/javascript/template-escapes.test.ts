import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { templateEscapePreprocess } from "./template-escapes.js";

describe("tagged templates with escapes a plain literal may not hold", () => {
  const src = [
    "import { toDisplay } from './paths';",
    "export function paths() {",
    "  const win = String.raw`C:\\users\\club\\xfiles/app.ts`;",
    "  const ok = `\\u00e9 ${'\\x41'}`;",
    "  return toDisplay(win, ok);",
    "}",
  ].join("\n");

  it("blanks the backslash of an invalid \\u / \\x escape in a template, length and valid escapes kept (real-repo FP)", async () => {
    expect((await parseSource(src, "typescript" as never, "paths.ts")).rootNode.hasError).toBe(true);
    const out = templateEscapePreprocess(src, "typescript")!;
    expect(out.sourceText).toHaveLength(src.length);
    expect(out.sourceText).toContain("String.raw`C: users\\club xfiles/app.ts`");
    expect(out.sourceText).toContain("`\\u00e9 ${'\\x41'}`");
    const tree = await parseSource(out.sourceText, "typescript" as never, "paths.ts");
    expect(tree.rootNode.hasError).toBe(false);
  });

  it("leaves a file without such an escape alone", () => {
    expect(templateEscapePreprocess("const a = `\\u00e9`;", "typescript")).toBeNull();
  });
});
