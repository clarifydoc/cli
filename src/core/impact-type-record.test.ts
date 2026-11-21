import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { impactOfContents } from "./impact-proposed.js";
import { filesNaming, namingIndex, targetsFromNames } from "./member-dependents.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const CONTROLLER_PY = [
  "from pkg.router import router",
  "",
  "",
  "@router.controller",
  "class MatchController:",
  "    def list_matches(self):",
  "        return self.lookup_club('a')",
  "",
  "    def lookup_club(self, slug):",
  "        return slug",
  "",
].join("\n");

const FILES: Record<string, string> = {
  "pkg/__init__.py": "",
  "pkg/router.py": "def controller(cls):\n    return cls\n",
  "pkg/controller.py": CONTROLLER_PY,
  "pkg/decoy.py": "from pkg import controller\n\n\ndef noop():\n    return controller\n",
  "pkg/other.py": "from pkg.router import router\n\n\ndef noop():\n    return router\n",
};

describe("a type with no usage record", () => {
  let dir: string;
  let root: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-type-record-"));
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

  const edited = CONTROLLER_PY.replace("class MatchController:\n", "class MatchController:\n    league = 'a'\n\n").replaceAll("lookup_club", "find_club");

  it("Python: a class nothing names by type charges only the files whose links reach it", async () => {
    const r = await run("pkg/controller.py", edited);
    expect(r.dependents).toEqual([]);
    expect(r.narrowed?.importers).toBe(1);
  });

  it("members given by name: a declared class nobody names counts as a known name that charges no file", () => {
    const index = namingIndex(summary, ["pkg/controller.py"]);
    const named = filesNaming(index, targetsFromNames(index, "pkg/controller.py", ["MatchController", "MatchController.nothing"]));
    expect(named.undecided).toBe(false);
    expect([...named.files.keys()]).toEqual([]);
    expect(named.named).toEqual([true, false]);
  });

  it("Python: a file importing the class by name, or annotating with it, is still charged", async () => {
    const files = { ...FILES, "pkg/builds.py": "from pkg.controller import MatchController\n\n\ndef build():\n    return MatchController()\n" };
    const dir2 = await mkdtemp(join(tmpdir(), "clarifydoc-type-record-"));
    try {
      const root2 = join(dir2, "app");
      for (const [f, text] of Object.entries(files)) {
        await mkdir(join(root2, f, ".."), { recursive: true });
        await writeFile(join(root2, f), text);
      }
      await analyze({ projectRoot: root2, outputDir: join(dir2, "out"), lsp: false, gitHistory: false, stableOutput: true });
      const s2 = await loadReportSummary(join(dir2, "out"));
      const r = await impactOfContents(s2, join(dir2, "out"), root2, new Map([["pkg/controller.py", edited]]));
      expect(r.dependents).toEqual(["pkg/builds.py"]);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  }, 60_000);
});
