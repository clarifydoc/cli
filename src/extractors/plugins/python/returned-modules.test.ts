import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

/** A local bound to a module: a function's returned import, a literal `importlib.import_module`. */
describe("Python modules held in locals", () => {
  let dir: string;
  const files: Record<string, string> = {
    "league/__init__.py": "",
    "league/club.py": "class Club:\n    pass\n\n\ndef save(n):\n    return n\n",
    "league/match.py": "def save(n):\n    return -n\n",
    "league/car.py": "def save(n):\n    return 0\n",
    "league/use.py": [
      "import importlib",
      "",
      "",
      "def load_club():",
      "    from league import club",
      "    return club",
      "",
      "",
      "def load_either(flag):",
      "    import league.club as c",
      "    import league.match as m",
      "    return c if flag else m",
      "",
      "",
      "def load_type():",
      "    from league.club import Club",
      "    return Club",
      "",
      "",
      "def run(name):",
      "    mod = load_club()",
      "    mod.save(1)",
      "    other = importlib.import_module(\"league.match\")",
      "    other.save(2)",
      "    dyn = importlib.import_module(name)",
      "    dyn.save(3)",
      "    either = load_either(True)",
      "    either.save(4)",
      "    kind = load_type()",
      "    kind.save(5)",
      "",
    ].join("\n"),
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-py-modules-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "proj", f)), { recursive: true });
      await writeFile(join(dir, "proj", f), text);
    }
    await analyze({ projectRoot: join(dir, "proj"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types a local as the module a function returns or a literal import_module names", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks
      .filter((l) => /^(mod|other|dyn|either|kind)\.save$/.test(l.callName))
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
    expect(links).toEqual(["mod.save -> league/club.py::save", "other.save -> league/match.py::save"]);
  });
});
