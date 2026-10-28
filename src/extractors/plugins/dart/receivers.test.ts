import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

/** Dart receivers typed through a field path, a named constructor and a collection's element. */
describe("Dart receivers", () => {
  let dir: string;
  const files: Record<string, string> = {
    "pubspec.yaml": "name: league\n",
    "lib/models/kit.dart": "class Kit {\n  Future<void> wash() async {}\n}\n",
    "lib/models/player.dart": "import 'kit.dart';\n\nclass Player {\n  final Kit kit;\n  Player(this.kit);\n}\n",
    "lib/club.dart": "class Club {\n  final String name;\n  Club(this.name);\n  Club.fromJson(Map<String, dynamic> json) : name = json['name'];\n  factory Club.empty() => Club('');\n  void kickOff() {}\n}\n",
    "lib/match.dart": "class Match {\n  void kickOff() {}\n}\n",
    "lib/main.dart": `import 'models/player.dart';
import 'club.dart';
import 'club.dart' as league;

void run(Player player, List<Club> clubs) {
  player.kit.wash();
  final a = Club.fromJson({});
  a.kickOff();
  final b = league.Club.empty();
  b.kickOff();
  clubs.forEach((c) => c.kickOff());
  clubs.where((c) => c.name.isNotEmpty).forEach((d) {
    d.kickOff();
  });
  for (final e in clubs) {
    e.kickOff();
  }
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-dart-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types each receiver by what declares it, never by a unique name alone", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks
      .filter((l) => l.sourceFile === "lib/main.dart")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol} ${l.strategy}`)
      .sort();
    expect(links).toEqual([
      // `league.Club.empty()`: a factory constructor, called on the class whatever its name.
      "Club.empty -> lib/club.dart::Club.empty class-name",
      "Club.fromJson -> lib/club.dart::Club.fromJson class-name",
      "a.kickOff -> lib/club.dart::Club.kickOff injection",
      "b.kickOff -> lib/club.dart::Club.kickOff injection",
      "c.kickOff -> lib/club.dart::Club.kickOff injection",
      "d.kickOff -> lib/club.dart::Club.kickOff injection",
      "e.kickOff -> lib/club.dart::Club.kickOff injection",
      "player.kit.wash -> lib/models/kit.dart::Kit.wash injection",
    ]);
  });
});
