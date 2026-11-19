import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const FILES: Record<string, string> = {
  "pubspec.yaml": "name: league\n",
  "lib/club.dart": `class Club { void save() {} }
class Player { void save() {} }

void shadowed(Club p) { [1].forEach((p) { p.save(); }); }
void shadowedDynamic(Club p) { [1].forEach((dynamic p) { p.save(); }); }
void shadowedBlock(Club p) {
  [1].forEach((p) {
    p.save();
  });
}
void outside(Club p) { [1].forEach((x) { x.toString(); }); p.save(); }
void unrelated(Club p) { [1].forEach((_) { p.save(); }); }
void after(Club p) { [1].forEach((p) => p.toString()); p.save(); }
`,
};

describe.each([["tree-sitter", undefined], ["regex", "no-tree-sitter:dart"]])("Dart closure parameters that shadow a typed formal (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-dart-shadow-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const target = (from: string) => summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === "p.save").map((l) => l.targetSymbol);

  it("links nothing for a closure's own untyped parameter", () => {
    expect(target("shadowed")).toEqual([]);
    expect(target("shadowedDynamic")).toEqual([]);
    expect(target("shadowedBlock")).toEqual([]);
  });

  it("keeps the formal's type outside the closure and under a closure that names another parameter", () => {
    expect(target("outside")).toEqual(["Club.save"]);
    expect(target("unrelated")).toEqual(["Club.save"]);
    expect(target("after")).toEqual(["Club.save"]);
  });
});
