import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { notebookPython } from "../extractors/plugins/python/notebook.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const nb = (cells: unknown[], metadata: unknown = { kernelspec: { name: "python3", language: "python" } }) =>
  JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata, cells });

const notebook = nb([
  { cell_type: "markdown", source: ["# Notes\n", "requests.get('/api/decoy')\n", "def decoy_in_markdown(): pass\n"] },
  {
    cell_type: "code",
    // a megabyte-wide output line must not make the notebook look minified
    outputs: [{ output_type: "stream", text: "x".repeat(20_000) }],
    source: ["%matplotlib inline\n", "import requests\n", "from league.clubs import rank_clubs\n", "!pip install foo\n"],
  },
  { cell_type: "code", source: "def load_table(con):\n    r = requests.get(\"/api/clubs\")\n    return rank_clubs(r)\n" },
  { cell_type: "code", source: "%%bash\nrequests.get('/api/decoy-bash')\ndef decoy_in_bash(): pass\n" },
]);

describe("Jupyter notebook", () => {
  let summary: ProjectAnalysis;
  let root: string;
  let out: string;
  const files: Record<string, string> = {
    "league/__init__.py": "",
    "league/clubs.py": "def rank_clubs(rows):\n    return sorted(rows)\n",
    "league/unused.py": "def never():\n    return 1\n",
    "notebooks/season.ipynb": notebook,
    // an R notebook is not read as Python
    "notebooks/model.ipynb": nb([{ cell_type: "code", source: "club <- read.csv('c.csv')\nrequests.get('/api/decoy-r')" }], { kernelspec: { name: "ir", language: "R" } }),
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "clarifydoc-nb-src-"));
    out = mkdtempSync(join(tmpdir(), "clarifydoc-nb-out-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("reads the code cells as Python: imports, functions and the HTTP call", () => {
    const calls = (summary.apiCalls ?? []).filter((c) => c.filePath === "notebooks/season.ipynb");
    expect(calls.map((c) => c.target)).toEqual(["/api/clubs"]);
    const links = summary.symbolLinks ?? [];
    expect(links.some((l) => JSON.stringify(l).includes("rank_clubs"))).toBe(true);
  });

  it("ignores markdown cells, shell cell magics and non-Python kernels", () => {
    const targets = (summary.apiCalls ?? []).map((c) => c.target);
    expect(targets.some((t) => (t ?? "").includes("decoy"))).toBe(false);
    expect(summary.files).toContain("notebooks/season.ipynb");
  });

  it("treats a notebook as an entry, so the module it imports is alive and a namesake is not", () => {
    expect(summary.deadCode?.entries?.map((e) => e.filePath)).toContain("notebooks/season.ipynb");
    const dead = (summary.deadCode?.files ?? []).map((f) => f.filePath);
    expect(dead).toContain("league/unused.py");
    expect(dead).not.toContain("league/clubs.py");
  });
});

describe("notebookPython", () => {
  it("blanks magics, keeps cell order and skips other kernels and oversized code", () => {
    const r = notebookPython(nb([{ cell_type: "code", source: ["%%time\n", "a = 1\n", "%load_ext sql\n", "b = 2"] }, { cell_type: "code", source: "c = 3" }]));
    expect("sourceText" in r && r.sourceText).toBe("\na = 1\n\nb = 2\n\nc = 3\n");
    expect(notebookPython(nb([], { language_info: { name: "julia" } }))).toEqual({ skip: "notebook kernel is julia, not Python" });
    expect(notebookPython("{ not json")).toEqual({ skip: "not valid notebook JSON" });
    expect(notebookPython(nb([{ cell_type: "code", source: "x = 1\n".repeat(400_000) }]))).toEqual({ skip: "notebook code past the size limit" });
  });
});
