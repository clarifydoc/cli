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

Boat harbour() => Boat();
`,
  "lib/run.dart": `import 'models.dart';

void after(List<Club> players) {
  for (final c in players) {
    c.save();
  }
  final c = Boat();
  c.save();
}

void before(List<Club> players) {
  final c = Boat();
  c.save();
  for (final c in players) {
    c.save();
  }
}

void mixed(List<Club> players, bool flag) {
  for (final c in players) {
    c.save();
  }
  if (flag) {
    final c = Boat();
    c.save();
  } else {
    final c = harbour();
    c.save();
  }
}

void unknown(List<Club> players) {
  for (final c in players) {
    c.save();
  }
  final c = harbour();
  c.save();
}
`,
};

describe.each([["tree-sitter", undefined], ["regex", "no-tree-sitter:dart"]])("Dart loop binders sharing a name (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-dart-loop-binders-"));
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
    summary.symbolLinks
      .filter((l) => l.sourceFile === "lib/run.dart" && l.sourceSymbol === from && l.callName === "c.save")
      .map((l) => `${l.sourceLine}->${l.targetSymbol}`)
      .sort();

  it("types the call after the loop by the declaration, the one inside by the loop's element", () => {
    expect(reaches("after")).toEqual(["5->Club.save", "8->Boat.save"]);
  });

  it("does the same when the declaration comes first", () => {
    expect(reaches("before")).toEqual(["13->Boat.save", "15->Club.save"]);
  });

  it("leaves the name as it was when another binding states no type", () => {
    expect(reaches("mixed")).toEqual(["21->Club.save"]);
  });

  it("adds nothing for a declaration whose type the source does not state", () => {
    expect(reaches("unknown").every((l) => l.endsWith("->Club.save"))).toBe(true);
    expect(reaches("unknown")).toHaveLength(1);
  });
});
