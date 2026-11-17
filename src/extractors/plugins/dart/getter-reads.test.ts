import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import "./meta.js";

/**
 * A getter is read like a field, so a read that crosses a file (a base class's getter, `club.badge` on a typed
 * receiver) or is written `this.squadSize` joins the getter's own calls to the reader's chain — on both front ends.
 * Never a getter of another class, a field, a parameter or local of the name, or a method handed on.
 */
const FILES: Record<string, string> = {
  "pubspec.yaml": "name: garage\ndependencies:\n  dio: ^5.0.0\n",
  "lib/base.dart": `import 'package:dio/dio.dart';

class SquadBase {
  int get squadSize { Dio().get('/api/squads/size'); return 11; }
  void save() {}
}

class Club {
  String get badge { Dio().get('/api/clubs/badge'); return 'b'; }
}
`,
  "lib/decoy.dart": `class Rival {
  int get squadSize => 3;
  String get badge => 'x';
}
`,
  "lib/use.dart": `import 'base.dart';
import 'decoy.dart';

class SquadBoard extends SquadBase {
  void inherited() { print(squadSize); }
  void interpolated() { print('size: $squadSize and \${this.squadSize}'); }
  void viaThis() { print(this.squadSize); }
  void viaTyped(Club club) { print(club.badge); }
  void viaLocal() { final Club c = Club(); print(c.badge); }
  void viaRival(Rival r) { print(r.squadSize); }
  void shadowed(int squadSize) { print(squadSize); }
  void localVar() { var squadSize = 1; print(squadSize); }
  void assigned() { this.squadSize = 2; }
  void handed() { run(save); }
  void commented() {
    // squadSize
    print("squadSize");
  }
}

class Plain {
  int squadSize = 0;
  void read() { print(squadSize); print(this.squadSize); }
}
`,
};

async function linksOf(feature: string | null): Promise<(file: string, from: string) => string[]> {
  const dir = await mkdtemp(join(tmpdir(), "cd-dart-getter-reads-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
    await writeFile(join(dir, "app", rel), text);
  }
  const previous = process.env.CLARIFYDOC_FEATURES;
  if (feature) process.env.CLARIFYDOC_FEATURES = feature;
  try {
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  } finally {
    if (previous === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = previous;
  }
  const summary = await loadReportSummary(join(dir, "out"));
  return (file, from) =>
    summary.symbolLinks.filter((l) => l.sourceFile === file && l.sourceSymbol === from && l.relation !== "reference").map((l) => `${l.callName}->${l.targetFile}::${l.targetSymbol}`);
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe.each([
  ["tree-sitter", null],
  ["regex", "no-tree-sitter:dart"],
])("Dart getter reads across files (%s front end)", (_name, feature) => {
  it("links a read of an inherited getter, `this.getter` and a getter on a typed receiver", async () => {
    const reaches = await linksOf(feature);
    const base = "lib/base.dart::SquadBase.squadSize";
    expect(reaches("lib/use.dart", "SquadBoard.inherited")).toContain(`squadSize->${base}`);
    expect(reaches("lib/use.dart", "SquadBoard.interpolated")).toContain(`squadSize->${base}`);
    expect(reaches("lib/use.dart", "SquadBoard.viaThis")).toContain(`this.squadSize->${base}`);
    expect(reaches("lib/use.dart", "SquadBoard.viaTyped")).toContain("club.badge->lib/base.dart::Club.badge");
    expect(reaches("lib/use.dart", "SquadBoard.viaLocal")).toContain("c.badge->lib/base.dart::Club.badge");
  }, 120_000);

  it("never links another class's getter, a field, a parameter, a local, a write, a method handed on or text", async () => {
    const reaches = await linksOf(feature);
    const getters = (from: string) => reaches("lib/use.dart", from).filter((x) => /squadSize|badge/.test(x));
    // A receiver typed as the namesake class reaches that class's getter, never the base's.
    expect(getters("SquadBoard.viaRival")).toEqual(["r.squadSize->lib/decoy.dart::Rival.squadSize"]);
    expect(getters("SquadBoard.shadowed")).toEqual([]);
    expect(getters("SquadBoard.localVar")).toEqual([]);
    expect(getters("SquadBoard.assigned")).toEqual([]);
    expect(getters("SquadBoard.commented")).toEqual([]);
    expect(reaches("lib/use.dart", "SquadBoard.handed").filter((x) => x.includes("save"))).toEqual([]);
    expect(getters("Plain.read")).toEqual([]);
  }, 120_000);
});
