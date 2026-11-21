import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { impactOfContents } from "./impact-proposed.js";
import { parseUnifiedHunks, symbolsOfChange } from "./changed-symbols.js";
import { computeImpactDiff } from "./impact-diff.js";
import { buildMcpServer } from "../mcp/server.js";
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
  "league/sched/__init__.py": "from .clock import *\nfrom .legacy.clock import tick\n",
  "league/sched/clock.py": "def kickoff():\n    return 1\n",
  "league/sched/legacy/__init__.py": "",
  "league/sched/legacy/clock.py": "def tick():\n    return 1\n\n\ndef whistle():\n    return 2\n",
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

  it("Python: the package file star-importing the edited module itself is charged", async () => {
    const r = await run("league/tasks/hooks.py", "from league.clock import add_job\n\n\ndef register_all():\n    return add_job('final')\n");
    expect(r.dependents).toContain("league/tasks/__init__.py");
  });

  it("a star export is followed to the file the import index resolves it to, not to every importee spelling its words", async () => {
    // `from .clock import *` forwards league/sched/clock.py; league/sched/legacy/clock.py shares the word and is only imported by name.
    expect(summary.starReexports?.["league/sched/__init__.py"]).toEqual({ ".clock": "league/sched/clock.py" });
    const r = await run("league/sched/legacy/clock.py", "def tick():\n    return 1\n");
    expect(r.dependents).not.toContain("league/sched/__init__.py");
  });

  it("a body edit that keeps every name charges no forwarder", async () => {
    const r = await run("league/tasks/hooks.py", "from league.clock import add_job\n\n\ndef register():\n    return add_job('semi-final')\n");
    expect(r.dependents).not.toContain("league/tasks/__init__.py");
  });

  it("a diff of pure deletions still narrows to the files naming what was cut", async () => {
    // git's own diff of a working tree that dropped `relegate` (old lines 4-6): no new-side range at all.
    const hunks = parseUnifiedHunks(["--- a/league/table.py", "+++ b/league/table.py", "@@ -4,3 +3,0 @@"].join("\n"));
    expect(hunks.size).toBe(0);
    const symbols = await symbolsOfChange(root, join(dir, "out"), summary, ["league/table.py"], hunks);
    const r = computeImpactDiff(summary, ["league/table.py"], { symbols });
    expect(r.dependents).toEqual(["league/drops.py"]);
  });

  it("a git diff that deletes a file charges the files naming what it held, like the proposed deletion", async () => {
    const diff = ["diff --git a/league/table.py b/league/table.py", "deleted file mode 100644", "--- a/league/table.py", "+++ /dev/null", "@@ -1,6 +0,0 @@"].join("\n");
    const hunks = parseUnifiedHunks(diff);
    const symbols = await symbolsOfChange(root, join(dir, "out"), summary, ["league/table.py"], hunks);
    expect(symbols.changed.map((c) => c.symbol).sort()).toEqual(["rank", "relegate"]);
    const r = computeImpactDiff(summary, ["league/table.py"], { symbols });
    expect(r.dependents).toEqual(["league/drops.py", "league/ranks.py"]);
  });

  it("a summary from before star re-exports were recorded follows none by path words and says to re-run", async () => {
    const old: ProjectAnalysis = { ...summary, starReexports: undefined, provenance: { ...summary.provenance!, extractorVersion: "1.721.0" } };
    const out = await impactOfContents(old, join(dir, "out"), root, new Map([["league/clock.py", CLOCK_PY.replace(/def add_job[^]*?\n\n\n/, "")]]));
    expect(out.dependents).toEqual(["league/tasks/hooks.py"]);
    expect(out.limitations?.some((l) => /re-run the analysis/.test(l))).toBe(true);
    // The current summary says nothing of the kind.
    const now = await run("league/clock.py", CLOCK_PY.replace(/def add_job[^]*?\n\n\n/, ""));
    expect(now.limitations?.some((l) => /re-run the analysis/.test(l)) ?? false).toBe(false);
  });

  it("blast_radius charges the forwarder only for a member that loses its name", async () => {
    const { server } = buildMcpServer({ projectRoot: root, analysisDir: join(dir, "out"), allowAnalyze: false, allowColdStart: false });
    const ask = async (args: Record<string, unknown>) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_blast_radius", arguments: { path: "league/clock.py", ...args } } });
      return (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    };
    const direct = (text: string) => /Direct dependents[^\n]*\n((?:- .*\n?)*)/.exec(text)?.[1] ?? "";
    expect(direct(await ask({ members: ["add_job"] }))).not.toContain("league/tasks/__init__.py");
    expect(direct(await ask({ members: ["add_job"], change: { add_job: "body" } }))).not.toContain("league/tasks/__init__.py");
    expect(direct(await ask({ members: ["add_job"], change: { add_job: "removed" } }))).toContain("league/tasks/__init__.py");
    // The decoy that only calls `tick` is never charged for `add_job`.
    expect(direct(await ask({ members: ["add_job"], change: { add_job: "removed" } }))).not.toContain("league/tasks/decoy.py");
  });

  it("impact marks the members whose name is lost", async () => {
    const r = await run("league/clock.py", CLOCK_PY.replace(/def add_job[^]*?\n\n\n/, ""));
    expect(r.narrowed?.members.find((m) => m.name === "add_job")?.lost).toBe(true);
    const body = await run("league/tasks/hooks.py", "from league.clock import add_job\n\n\ndef register():\n    return add_job('semi-final')\n");
    expect(body.narrowed?.members.every((m) => !m.lost)).toBe(true);
  });
});
