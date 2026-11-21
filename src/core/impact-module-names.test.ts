import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { impactOfContents } from "./impact-proposed.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const SETTINGS_PY = ["import os", "", "SEASON_LIMIT = 38", "", "# the pitch", 'PITCH = "grass"', "", "def table():", "    return os.sep", ""].join("\n");
const SETTINGS_TS = ["import { hosts } from './hosts';", "", "export const SEASON_LIMIT = 38;", "export const PITCH = 'grass';", "", "export function table() {", "  return hosts;", "}", ""].join("\n");

const FILES: Record<string, string> = {
  "pkg/__init__.py": "",
  "pkg/settings.py": SETTINGS_PY,
  "pkg/reads_limit.py": "from pkg.settings import SEASON_LIMIT\n\n\ndef limit():\n    return SEASON_LIMIT\n",
  "pkg/reads_module.py": "from pkg import settings\n\n\ndef pitch():\n    return settings.PITCH\n",
  "pkg/reads_pitch.py": "from pkg.settings import PITCH\n\n\ndef pitch():\n    return PITCH\n",
  "pkg/calls_table.py": "from pkg.settings import table\n\n\ndef rows():\n    return table()\n",
  "web/hosts.ts": "export const hosts = ['north'];\n",
  "web/settings.ts": SETTINGS_TS,
  "web/reads-limit.ts": "import { SEASON_LIMIT } from './settings';\nexport const cap = SEASON_LIMIT + 1;\n",
  "web/reads-whole.ts": "import * as settings from './settings';\nexport const p = settings.PITCH;\n",
  "web/calls-table.ts": "import { table } from './settings';\nexport const t = table();\n",
};

describe("impact charges the files that read an edited module-level name", () => {
  let dir: string;
  let root: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-module-names-"));
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

  it("Python: a constant charges its named reader and the module-whole reader, not the importers of other names", async () => {
    const r = await run("pkg/settings.py", SETTINGS_PY.replace("SEASON_LIMIT = 38", "SEASON_LIMIT = 40"));
    expect(r.dependents).toEqual(["pkg/reads_limit.py", "pkg/reads_module.py"]);
  });

  it("Python: an edit no name owns keeps every importer", async () => {
    const r = await run("pkg/settings.py", SETTINGS_PY.replace("import os\n\n", "import os\nif os.sep:\n    pass\n"));
    expect(r.dependents.length).toBeGreaterThanOrEqual(4);
  });

  it("TypeScript: a constant charges the file importing it and the namespace reader, not the one importing a function", async () => {
    const r = await run("web/settings.ts", SETTINGS_TS.replace("= 38;", "= 40;"));
    expect(r.dependents).toEqual(["web/reads-limit.ts", "web/reads-whole.ts"]);
  });
});
