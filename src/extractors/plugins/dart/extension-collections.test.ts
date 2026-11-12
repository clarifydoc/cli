import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import "./meta.js";

/**
 * An extension on a collection of one element type (`extension on List<Club>`, `on Iterable<Club>`, a bounded
 * `List<T extends Club>`) answers a call on a collection declared with that element, and never one of another
 * element's same-named extension (real-repo FP: the receiver `List` alone named no project class, so two extensions
 * of one name on lists of different models stayed unlinked, or were guessed by name).
 */
const FILES: Record<string, string> = {
  "pubspec.yaml": "name: league\n",
  "lib/models.dart": "class Club {\n  int id = 0;\n}\n\nclass Player {\n  int id = 0;\n}\n",
  "lib/club_ext.dart": `import 'package:league/models.dart';

extension ClubListX<T extends Club> on List<T> {
  int totalPoints() => length;
}

extension ClubIterX on Iterable<Club> {
  int topScore() => 1;
}

extension ClubSetX on Set<Club> {
  int uniqueNames() => 2;
}

extension AnyListX<T> on List<T> {
  int firstOrZero() => 0;
}
`,
  "lib/player_ext.dart": `import 'package:league/models.dart';

extension PlayerListX on List<Player> {
  int totalPoints() => length;
}

extension PlayerIterX on Iterable<Player> {
  int topScore() => 9;
}

extension PlayerSetX on Set<Player> {
  int uniqueNames() => 8;
}
`,
  "lib/desk.dart": `import 'package:league/models.dart';
import 'package:league/club_ext.dart';
import 'package:league/player_ext.dart';

class Desk {
  final List<Club> clubs = [];
  final List<Player> players = [];

  int viaParam(List<Club> cs) => cs.totalPoints();
  int viaField() => clubs.totalPoints();
  int viaIterable(Iterable<Club> cs) => cs.topScore();
  int viaSet(Set<Club> cs) => cs.uniqueNames();
  int playersField() => players.totalPoints();
  int playersIterable(Iterable<Player> ps) => ps.topScore();
  int playersSet(Set<Player> ps) => ps.uniqueNames();
  int viaLocal() {
    final List<Club> local = [];
    return local.totalPoints();
  }

  int anyList(List<Player> ps) => ps.firstOrZero();
}
`,
};

describe.each([["tree-sitter", undefined], ["regex", "no-tree-sitter:dart"]])("Dart extensions on a collection (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-dart-ext-coll-"));
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

  const targets = (from: string, call: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceSymbol === `Desk.${from}` && l.callName === call && l.relation !== "reference")
      .map((l) => `${l.targetFile}::${l.targetSymbol}`);

  it("links a call on a list of the element its bound or written type names, never the other element's extension", () => {
    expect(targets("viaParam", "cs.totalPoints")).toEqual(["lib/club_ext.dart::ClubListX.totalPoints"]);
    expect(targets("viaField", "clubs.totalPoints")).toEqual(["lib/club_ext.dart::ClubListX.totalPoints"]);
    expect(targets("viaLocal", "local.totalPoints")).toEqual(["lib/club_ext.dart::ClubListX.totalPoints"]);
    expect(targets("playersField", "players.totalPoints")).toEqual(["lib/player_ext.dart::PlayerListX.totalPoints"]);
  });

  it("matches an extension on an Iterable or a Set the same way", () => {
    expect(targets("viaIterable", "cs.topScore")).toEqual(["lib/club_ext.dart::ClubIterX.topScore"]);
    expect(targets("playersIterable", "ps.topScore")).toEqual(["lib/player_ext.dart::PlayerIterX.topScore"]);
    expect(targets("viaSet", "cs.uniqueNames")).toEqual(["lib/club_ext.dart::ClubSetX.uniqueNames"]);
    expect(targets("playersSet", "ps.uniqueNames")).toEqual(["lib/player_ext.dart::PlayerSetX.uniqueNames"]);
  });

  it("never takes a list of one element for another's, whatever else shares the call's name", () => {
    expect(targets("anyList", "ps.firstOrZero")).not.toContain("lib/club_ext.dart::ClubListX.totalPoints");
    expect(targets("playersField", "players.totalPoints")).not.toContain("lib/club_ext.dart::ClubListX.totalPoints");
    expect(targets("viaField", "clubs.totalPoints")).not.toContain("lib/player_ext.dart::PlayerListX.totalPoints");
  });
});
