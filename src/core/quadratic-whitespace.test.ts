import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyzeFile } from "./file-analyzer.js";
import { EXTENSION_TO_LANGUAGE, loadAllPlugins } from "../extractors/registry.js";
import { stripHashComment } from "../extractors/plugins/shared/text-scan.js";
import { stripHashLines } from "../extractors/plugins/shared/graphql-sdl.js";

/**
 * A long whitespace run must be read once. A pattern that starts an attempt at every position of the run, and
 * lets each attempt read the run to its end, costs seconds on one 100,000-character line or 50,000 blank lines,
 * and the worker deadline then drops the file.
 */
const RUN = 100_000;
const PROBES = {
  spaces: `x = 1${" ".repeat(RUN)}\n  .to_s\n`,
  onlySpaces: `${" ".repeat(RUN)}\n`,
  star: `func main() {\n${" ".repeat(RUN)}*\n}\n`,
  blanks: `import os\n${"\n".repeat(RUN / 2)}x = 1\n`,
  tabs: `x = 1${"\t".repeat(RUN)}# c\n`,
} as const;

const LANGUAGES = [".rb", ".go", ".py", ".pl", ".razor", ".swift", ".v", ".fs", ".php", ".c", ".cpp", ".trigger", ".graphql", ".ahk", ".rs", ".scala", ".cs", ".java"];

describe("whitespace runs are read once", () => {
  let root: string;
  let out: string;
  beforeAll(async () => {
    await loadAllPlugins();
    root = mkdtempSync(join(tmpdir(), "clarifydoc-ws-"));
    out = join(root, "out");
    mkdirSync(out);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const ext of LANGUAGES) {
    for (const [name, body] of Object.entries(PROBES)) {
      it(`${ext} ${name} under one second`, async () => {
        const language = EXTENSION_TO_LANGUAGE[ext]!;
        const rel = `probe${ext}`;
        const abs = join(root, rel);
        writeFileSync(abs, body);
        const started = Date.now();
        await analyzeFile({ file: { absolutePath: abs, relativePath: rel, language }, frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false }, verbose: false, projectRoot: root, tsconfigAliases: new Map() } as never);
        expect(Date.now() - started).toBeLessThan(1000);
      });
    }
  }
});

describe("the linear readings equal the patterns they replace", () => {
  const PIECES = ["a", "b = 1", " ", "  ", "\t", "\n", "\r\n", "#", "# note", "\u2028", "x#y", "\f"];
  const random = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const sample = (): string => Array.from({ length: Math.floor(random() * 9) }, () => PIECES[Math.floor(random() * PIECES.length)]!).join("");

  it("stripHashComment is replace(/\\s+#.*$/)", () => {
    for (let i = 0; i < 4000; i++) {
      const s = sample();
      expect(stripHashComment(s), JSON.stringify(s)).toBe(s.replace(/\s+#.*$/, ""));
    }
  });

  it("stripHashLines is replace(/^\\s*#.*$/gm)", () => {
    for (let i = 0; i < 4000; i++) {
      const s = sample();
      expect(stripHashLines(s), JSON.stringify(s)).toBe(s.replace(/^\s*#.*$/gm, ""));
    }
  });
});
