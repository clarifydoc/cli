import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { fieldCollections } from "./element-types.js";

describe("fieldCollections", () => {
  it("keeps the fields typed as a list or a map of a class", () => {
    const p = (name: string, type: string) => ({ name, type, visibility: null, isStatic: false, isReadonly: false });
    const got = fieldCollections([p("clubs", "List<Club>"), p("byName", "Map<String, Club>"), p("n", "int")]);
    expect([...got!.lists]).toEqual([["clubs", "Club"]]);
    expect([...got!.maps]).toEqual([["byName", "Club"]]);
    expect(fieldCollections([p("n", "int")])).toBeNull();
  });
});

const FILES: Record<string, string> = {
  "pubspec.yaml": "name: league\n",
  "lib/club.dart": `class Club { void promote() {} }
class Player { void promote() {} }

class League {
  final List<Club> clubs = [];
  Map<String, Club> byName = {};
  void fromField() {
    for (final c in clubs) { c.promote(); }
    for (final c in this.clubs) { c.promote(); }
    clubs.forEach((c) => c.promote());
    clubs.map((c) => c.promote()).toList();
    for (final c in byName.values) { c.promote(); }
    byName.forEach((k, v) => v.promote());
  }
  void index() {
    clubs[0].promote();
    final c = byName['a']!;
    c.promote();
    byName['b']?.promote();
    clubs.first.promote();
    clubs.last.promote();
  }
}
void narrow(Object x, Object? y) {
  if (x is Club) x.promote();
  if (y is Club) { y.promote(); }
  if (x is! Club) return;
  x.promote();
}
void loops(List<Club> clubs) {
  for (final c in clubs) { c.promote(); }
  clubs.forEach((c) => c.promote());
}
void locals() {
  final clubs = <Club>[];
  for (final c in clubs) { c.promote(); }
  var more = [Club()];
  for (var c in more) { c.promote(); }
}

void mixed(List<Club> a, List<Player> b) {
  for (final z in a) { z.promote(); }
  for (final z in b) { z.promote(); }
}
void decoy(List<Player> players, Map<String, Player> byId, Object o) {
  for (final p in players) { p.promote(); }
  for (final q in byId.values) { q.promote(); }
  if (o is Player) o.promote();
}
void plain(List<String> names) {
  for (final n in names) { n.promote(); }
}
`,
};

describe.each([["tree-sitter", undefined], ["regex", "no-tree-sitter:dart"]])("Dart collections, element reads and `is` narrowing (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-dart-elements-"));
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

  const target = (from: string, callName: string) =>
    summary.symbolLinks
      .filter((l) => (l.sourceSymbol === from || l.sourceSymbol.endsWith(`.${from}`)) && l.callName === callName)
      .map((l) => l.targetSymbol);

  it("types loops and closures over a field, a map's values and a literal-built local", () => {
    expect(target("fromField", "c.promote")).toEqual(["Club.promote"]);
    expect(target("fromField", "v.promote")).toEqual(["Club.promote"]);
    expect(target("locals", "c.promote")).toEqual(["Club.promote"]);
  });

  it("types an element read by index, first or last", () => {
    expect(target("index", "c.promote")).toEqual(["Club.promote"]);
    expect(target("index", "clubs.first.promote")).toEqual(["Club.promote"]);
    expect(target("index", "clubs.last.promote")).toEqual(["Club.promote"]);
    expect(target("index", "clubs[].promote")).toEqual(["Club.promote"]);
    expect(target("index", "byName[].promote")).toEqual(["Club.promote"]);
  });

  it("types a name an `is` test promotes", () => {
    expect(target("narrow", "x.promote")).toEqual(["Club.promote"]);
    expect(target("narrow", "y.promote")).toEqual(["Club.promote"]);
    expect(target("decoy", "o.promote")).toEqual(["Player.promote"]);
  });

  it("keeps the namesake apart and leaves ambiguous bindings untyped", () => {
    expect(target("decoy", "p.promote")).toEqual(["Player.promote"]);
    expect(target("decoy", "q.promote")).toEqual(["Player.promote"]);
    expect(target("mixed", "z.promote")).toEqual([]);
    expect(target("plain", "n.promote")).toEqual([]);
  });
});
