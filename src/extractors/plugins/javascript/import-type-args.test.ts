import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { importTypeArgPreprocess } from "./import-type-args.js";

const src = [
  'import { load } from "./loader";',
  "export async function openClub(id: string) {",
  '  const club = load<typeof import("./club")>(id);',
  "  const coach = pick<import('./coach').Coach, Other>();",
  '  const keep: Array<typeof import("./club")> = [];',
  "  return report(club, coach, keep);",
  "}",
].join("\n");

describe("a call whose type argument is an import type", () => {
  it("rewrites the import type of a call's type argument to a same-length name the grammar reads as a type", async () => {
    expect((await parseSource(src, "typescript" as never, "open.ts")).rootNode.hasError).toBe(true);
    const out = importTypeArgPreprocess(src, "typescript")!;
    expect(out.sourceText).toHaveLength(src.length);
    expect(out.sourceText.split("\n").map((l) => l.length)).toEqual(src.split("\n").map((l) => l.length));
    // A type annotation the grammar already reads is left alone.
    expect(out.sourceText).toContain('Array<typeof import("./club")>');
    const tree = await parseSource(out.sourceText, "typescript" as never, "open.ts");
    expect(tree.rootNode.hasError).toBe(false);
  });

  it("keeps the calls and the imports the type arguments name", async () => {
    const root = mkdtempSync(join(tmpdir(), "import-type-args-"));
    try {
      const abs = join(root, "open.ts");
      writeFileSync(abs, src);
      const { analyzeFile } = await import("../../../core/file-analyzer.js");
      const result = await analyzeFile({
        file: { absolutePath: abs, relativePath: "open.ts", language: "typescript" },
        frameworkIds: [],
        projectId: "root",
        outputOpts: { outputDir: join(root, "out"), pretty: false },
        verbose: false,
        projectRoot: root,
        tsconfigAliases: new Map(),
      } as never);
      const analysis = result!.analysis;
      const fn = analysis.functions.find((f) => f.name === "openClub")!;
      expect(fn.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["load", "pick", "report"]));
      expect(fn.calls.some((c) => /^_+$/.test(c.name))).toBe(false);
      expect(analysis.imports.map((i) => [i.source, i.line])).toEqual(
        expect.arrayContaining([["./loader", 1], ["./club", 3], ["./coach", 4], ["./club", 5]]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a file without such a call alone", () => {
    expect(importTypeArgPreprocess('type Club = typeof import("./club");', "typescript")).toBeNull();
  });
});
