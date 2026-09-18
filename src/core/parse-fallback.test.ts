import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * When tree-sitter cannot parse a file, extraction falls back to regex and the
 * result is indistinguishable on disk from a first-class regex language: no
 * complexity rows, coarser calls, no AST routes. The realistic trigger is a
 * grammar that failed to load, which degrades EVERY file of that language at
 * once — so the silent version of this is a whole language quietly getting
 * worse with no signal. Nothing covered the branch before.
 */
vi.mock("../parsers/parser-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parsers/parser-manager.js")>();
  return {
    ...actual,
    parseSource: vi.fn(async () => {
      throw new Error("No grammar registered for typescript (failed to load .wasm)");
    }),
  };
});

let root: string;
let out: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarifydoc-fallback-"));
  out = join(root, "out");
  mkdirSync(out, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("regex fallback after a parse failure", () => {
  it("marks the analysis, which is the only signal that the file lost its facts", async () => {
    const { analyzeFile } = await import("./file-analyzer.js");
    const abs = join(root, "svc.ts");
    writeFileSync(abs, `export function alpha() { return 1; }\nexport function beta() { return 2; }\n`);

    const result = await analyzeFile({
      file: { absolutePath: abs, relativePath: "svc.ts", language: "typescript" },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);

    expect(result).not.toBeNull();
    const analysis = result!.analysis;
    expect(analysis.extraction).toEqual({
      method: "regex",
      fallback: true,
      reason: "grammar-unavailable",
    });
    // And the marker is not cosmetic: TypeScript has no regex spec, so for a
    // tree-sitter-only language the "fallback" extracts NOTHING. Two exported
    // functions go in and nothing comes out. Without the marker that is
    // indistinguishable from a genuinely empty file.
    expect(analysis.functions).toEqual([]);
    expect(analysis.exports).toEqual([]);
  });

  it("classifies the failure without leaking the raw message", async () => {
    const { analyzeFile } = await import("./file-analyzer.js");
    const abs = join(root, "other.ts");
    writeFileSync(abs, `export const x = 1;\n`);
    const result = await analyzeFile({
      file: { absolutePath: abs, relativePath: "other.ts", language: "typescript" },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    const reason = result!.analysis.extraction!.reason;
    expect(["grammar-unavailable", "null-tree", "parser-error"]).toContain(reason);
    expect(JSON.stringify(result!.analysis)).not.toContain(".wasm");
  });
});
