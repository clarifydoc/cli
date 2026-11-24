import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis, SymbolLink } from "../types/analysis.js";

/**
 * A name binds only where its scope reaches: an import inside one function is that function's. Each project has a
 * decoy whose right link must stay.
 */
const PROJECTS: Record<string, Record<string, string>> = {
  python: {
    "pyproject.toml": "[project]\nname = \"league\"\n",
    "league/__init__.py": "",
    "league/util.py": "def helper():\n    return 1\n",
    "league/desk.py": `from league.util import helper


def own():
    return helper()


def local_import():
    from league.util import helper
    return helper()


def no_import():
    return helper()


def other_name():
    return helper()
`,
    "league/bench.py": `def sign():
    from league.util import helper
    return helper()


def bench():
    return helper()
`,
  },
};

const results: Record<string, ProjectAnalysis> = {};
const roots: string[] = [];

beforeAll(async () => {
  for (const [lang, files] of Object.entries(PROJECTS)) {
    const root = await mkdtemp(join(tmpdir(), `names-in-scope-${lang}-`));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
    const out = join(root, ".out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
    results[lang] = await loadReportSummary(out);
  }
}, 120_000);

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const linksOf = (lang: string, sourceSymbol: string, callName: string, file?: string): SymbolLink[] =>
  (results[lang]!.symbolLinks ?? []).filter((l) => l.sourceSymbol === sourceSymbol && l.callName === callName && (!file || l.sourceFile === file));

describe("symbol-linker — a name binds only where its scope reaches", () => {
  describe("Python", () => {
    it("binds an import inside a function to that function only", () => {
      expect(linksOf("python", "local_import", "helper")[0]).toMatchObject({ targetSymbol: "helper", targetFile: "league/util.py" });
      expect(linksOf("python", "bench", "helper", "league/bench.py")).toEqual([]);
    });

    it("keeps the module-level import for every function of the module", () => {
      expect(linksOf("python", "own", "helper")[0]).toMatchObject({ targetSymbol: "helper", targetFile: "league/util.py" });
      expect(linksOf("python", "other_name", "helper")[0]).toMatchObject({ targetSymbol: "helper", targetFile: "league/util.py" });
    });
  });
});
