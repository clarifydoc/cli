import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { impactOfContents } from "./impact-proposed.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const CLOCK_PY = ["def add_job(name):", "    return name", "", "", "def tick():", "    return 1", ""].join("\n");
const CLOCK_TS = ["export function addJob(name: string) {", "  return name;", "}", "", "export function tick() {", "  return 1;", "}", ""].join("\n");

const FILES: Record<string, string> = {
  "league/__init__.py": "",
  "league/clock.py": CLOCK_PY,
  "league/tasks/__init__.py": "from .hooks import *\n",
  "league/tasks/hooks.py": "from league.clock import add_job\n\n\ndef register():\n    return add_job('final')\n",
  "league/tasks/decoy.py": "from league.clock import tick\n\n\ndef beat():\n    return tick()\n",
  "league/app.py": "from league import tasks\n\n\ndef boot():\n    return tasks\n",
  "web/clock.ts": CLOCK_TS,
  "web/hooks/index.ts": "export * from './hooks';\n",
  "web/hooks/hooks.ts": "import { addJob } from '../clock';\nexport const register = () => addJob('final');\n",
  "league/table.py": "def rank():\n    return 1\n\n\ndef relegate():\n    return 2\n",
  "league/ranks.py": "from league.table import rank\n\n\ndef top():\n    return rank()\n",
  "league/drops.py": "from league.table import relegate\n\n\ndef bottom():\n    return relegate()\n",
  "web/decoy.ts": "import { tick } from './clock';\nexport const beat = () => tick();\n",
};

describe("impact charges a file that hands a charged module on whole", () => {
  let dir: string;
  let root: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-star-forwarders-"));
    root = join(dir, "app");
    for (const [f, text] of Object.entries(FILES)) {
      await mkdir(join(root, f, ".."), { recursive: true });
      await writeFile(join(root, f), text);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const run = (file: string, content: string) => impactOfContents(summary, join(dir, "out"), root, new Map([[file, content]]));

  it("Python: the package file star-importing the caller is charged with it, the namesake decoy and the package's importer are not", async () => {
    const r = await run("league/clock.py", CLOCK_PY.replace(/def add_job[^]*?\n\n\n/, ""));
    expect(r.dependents).toEqual(["league/tasks/__init__.py", "league/tasks/hooks.py"]);
  });

  it("TypeScript: a barrel re-exporting the caller with `export *` is charged with it", async () => {
    const r = await run("web/clock.ts", CLOCK_TS.replace(/export function addJob[^]*?\n}\n\n/, ""));
    expect(r.dependents).toEqual(["web/hooks/hooks.ts", "web/hooks/index.ts"]);
  });

  it("a decorator inserted right above a function is an edit of that function: only its callers are charged", async () => {
    const r = await run("league/table.py", "def rank():\n    return 1\n\n\n@memoize\ndef relegate():\n    return 2\n");
    expect(r.dependents).toEqual(["league/drops.py"]);
  });
});
