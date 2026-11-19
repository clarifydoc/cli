import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const FILES: Record<string, string> = {
  "pubspec.yaml": "name: league\n",
  "lib/models.dart": `class Club {
  void save() {}
}

class Boat {
  void save() {}
}
`,
  "lib/team.dart": `import 'models.dart';

class Team {
  Club _best = Club();
  Boat _tender = Boat();

  Club get best => _best;

  set best(Club v) {
    _best = v;
    v.save();
  }

  set tender(Boat b) => b.save();
}

set topClub(Club c) {
  c.save();
}
`,
};

describe.each([["tree-sitter", undefined], ["regex", "no-tree-sitter:dart"]])("Dart setter bodies (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-dart-setters-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const reaches = (from: string) =>
    summary.symbolLinks.filter((l) => l.sourceFile === "lib/team.dart" && l.sourceSymbol === from && l.relation !== "reference").map((l) => `${l.callName}->${l.targetFile}::${l.targetSymbol}`);

  it("is a function named as Dart spells it, beside a getter of the same name", () => {
    expect(reaches("Team.best=")).toEqual(["v.save->lib/models.dart::Club.save"]);
    expect(reaches("Team.best")).toEqual([]);
  });

  it("types the setter's parameter, never a namesake member of another class", () => {
    expect(reaches("Team.tender=")).toEqual(["b.save->lib/models.dart::Boat.save"]);
    expect(reaches("topClub=")).toEqual(["c.save->lib/models.dart::Club.save"]);
  });
});
