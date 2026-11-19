import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

/** A Dart local that is another typed name (`final c = club;`, `final c = maybe!;`) is typed as that name. */
describe("Dart alias locals", () => {
  let dir: string;
  const files: Record<string, string> = {
    "pubspec.yaml": "name: league\n",
    "lib/club.dart": "class Club {\n  void save() {}\n}\n",
    "lib/player.dart": "class Player {\n  void save() {}\n}\n",
    "lib/service.dart": `import 'club.dart';
import 'player.dart';

class Service {
  Club? maybe;
  Club field = Club();
  Future<void> promote(Club club) async {
    final c = club;
    c.save();
  }
  void bang(Club? club) {
    club!.save();
  }
  void bangLocal(Club? club) {
    final c = club!;
    c.save();
  }
  void fromField() {
    final c = field;
    c.save();
  }
  void fromCtor() {
    final a = Club();
    final c = a;
    c.save();
  }
  void fromNullableField() {
    final c = maybe!;
    c.save();
  }
  void rebound(Club club, Player player) {
    var c = club;
    c = player;
    c.save();
  }
  void reboundInBranch(Club club, Player player, bool x) {
    var c = club;
    if (x) c = player;
    c.save();
  }
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-dart-alias-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const flag of [[], ["no-tree-sitter:dart"]]) {
    it(`reaches Club.save through the alias (${flag.join("") || "default front end"}), never Player.save`, async () => {
      const out = join(dir, `out${flag.length}`);
      const before = process.env.CLARIFYDOC_FEATURES;
      process.env.CLARIFYDOC_FEATURES = flag.join(",");
      try {
        await analyze({ projectRoot: join(dir, "app"), outputDir: out, lsp: false, gitHistory: false });
      } finally {
        if (before === undefined) delete process.env.CLARIFYDOC_FEATURES;
        else process.env.CLARIFYDOC_FEATURES = before;
      }
      const summary = await loadReportSummary(out);
      const links = summary.symbolLinks
        .filter((l) => l.sourceFile === "lib/service.dart" && l.callName.endsWith(".save"))
        .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`)
        .sort();
      expect(links).toEqual([
        "Service.bang club.save -> Club.save",
        "Service.bangLocal c.save -> Club.save",
        "Service.fromCtor c.save -> Club.save",
        "Service.fromField c.save -> Club.save",
        "Service.fromNullableField c.save -> Club.save",
        "Service.promote c.save -> Club.save",
      ]);
    });
  }
});
