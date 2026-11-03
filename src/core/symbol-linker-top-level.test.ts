/**
 * A script's own statements — a PHP page above its markup, a Python module, a
 * Ruby script or seed file — are the file's `<setup>`, and the locals they
 * type resolve the calls they make, as a function's would. Through the real
 * per-file pipeline, then the linker.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis, Language } from "../types/analysis.js";

async function analyzeAll(files: Record<string, string>, language: Language): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "top-level-"));
  const out = await mkdtemp(join(tmpdir(), "top-level-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

/** The member calls `symbol` in `from` makes, as `callName -> file::symbol [strategy/confidence]`. */
function memberCalls(analyses: FileAnalysis[], from: string, symbol: string): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.sourceFile === from && l.sourceSymbol === symbol && l.callName.includes("."))
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol} [${l.strategy}/${l.confidence}]`)
    .sort();
}

describe("top-level script code types its own locals", () => {
  it("PHP: a page's `$repo = new ClubRepo()` above its markup types `$repo->all()`, never a namesake's", async () => {
    const analyses = await analyzeAll({
      "lib/ClubRepo.php": "<?php\nclass ClubRepo {\n    public function all() { return []; }\n}\n",
      "lib/Garage.php": "<?php\nclass Garage {\n    public function all() { return []; }\n}\n",
      "clubs.php": [
        "<?php",
        "require_once __DIR__ . '/lib/ClubRepo.php';",
        "require_once __DIR__ . '/lib/Garage.php';",
        "$repo = new ClubRepo();",
        "?>",
        "<ul>",
        "<?php foreach ($repo->all() as $c): ?>",
        "  <li><?= $c ?></li>",
        "<?php endforeach; ?>",
        "</ul>",
        "",
      ].join("\n"),
    }, "php");
    expect(memberCalls(analyses, "clubs.php", "<setup>")).toEqual(["repo.all -> lib/ClubRepo.php::ClubRepo.all [injection/INFERRED]"]);
  });

  it("Python: a module's `repo = ClubRepo()` types the `repo.all()` its own statements make", async () => {
    const analyses = await analyzeAll({
      "league/__init__.py": "",
      "league/repo.py": "class ClubRepo:\n    def all(self):\n        return []\n\nclass Garage:\n    def all(self):\n        return []\n",
      "league/report.py": [
        "from league.repo import ClubRepo",
        "",
        "repo = ClubRepo()",
        "for club in repo.all():",
        "    print(club)",
        "",
      ].join("\n"),
    }, "python");
    expect(memberCalls(analyses, "league/report.py", "<setup>")).toEqual(["repo.all -> league/repo.py::ClubRepo.all [injection/INFERRED]"]);
  });

  it("Ruby: a script's and a seed file's statements are their `<setup>`; a library file's are not", async () => {
    const script = 'require_relative "../lib/club_repo"\nrepo = ClubRepo.new\nrepo.all\n';
    const analyses = await analyzeAll({
      "lib/club_repo.rb": "class ClubRepo\n  def all\n    []\n  end\nend\n",
      "lib/garage.rb": "class Garage\n  def all\n    []\n  end\nend\n",
      "script/report.rb": script,
      "db/seeds.rb": script,
      "lib/boot.rb": script,
    }, "ruby");
    expect(memberCalls(analyses, "script/report.rb", "<setup>")).toEqual([
      "ClubRepo.new -> lib/club_repo.rb::ClubRepo [constructor/INFERRED]",
      "repo.all -> lib/club_repo.rb::ClubRepo.all [injection/INFERRED]",
    ]);
    expect(memberCalls(analyses, "db/seeds.rb", "<setup>")).toEqual([
      "ClubRepo.new -> lib/club_repo.rb::ClubRepo [constructor/INFERRED]",
      "repo.all -> lib/club_repo.rb::ClubRepo.all [injection/INFERRED]",
    ]);
    expect(analyses.find((a) => a.filePath === "lib/boot.rb")!.functions.map((f) => f.name)).toEqual([]);
  });
});
