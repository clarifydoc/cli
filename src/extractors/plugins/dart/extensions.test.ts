import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const EXT = `import 'club.dart';

extension ClubTypeBadge on ClubType {
  bool showBadge() {
    return this == ClubType.pro;
  }

  String label() => name;

  static ClubType parse(String s) => ClubType.pro;
}

extension on Club {
  String crest() {
    return this.name.toUpperCase();
  }
}

extension Squad<P extends Player> on P {
  void rest() {}
}

extension Anything<T> on T {
  void warmUp() {}
}
`;

/** Each member of an `extension … on T` block is the extended type's: a receiver parameter of type T. */
describe("Dart extension members", () => {
  it("take the extended type as their receiver: named, unnamed, and a bounded type parameter", () => {
    const a = extractWithRegex(EXT, "lib/club_ext.dart", "dart") as FileAnalysis;
    const all = [...a.functions, ...a.classes.flatMap((c) => c.methods)];
    const recv = (name: string) => all.find((f) => f.name === name)?.params.find((p) => p.isReceiver)?.type;
    expect(recv("showBadge")).toBe("ClubType");
    expect(recv("label")).toBe("ClubType");
    expect(recv("crest")).toBe("Club");
    expect(recv("rest")).toBe("Player"); // `on P` with `P extends Player`: the bound
    expect(recv("parse")).toBeUndefined(); // static: called through the extension's name
    expect(recv("warmUp")).toBeUndefined(); // `on T` unbounded extends every type, which states nothing
    expect(a.classes.map((c) => c.name)).toEqual(["ClubTypeBadge", "Squad", "Anything"]);
  });

  let dir: string;
  const files: Record<string, string> = {
    "pubspec.yaml": "name: league\n",
    "lib/club.dart": "enum ClubType { amateur, pro }\n\nclass Club {\n  final String name;\n  Club(this.name);\n}\n\nclass YouthClub extends Club {\n  YouthClub(String name) : super(name);\n}\n\nclass Player {}\n\nclass Keeper extends Player {}\n",
    "lib/club_ext.dart": EXT,
    // Namesakes: a class declaring the same members, and an extension of another type.
    "lib/trophy.dart": "class Trophy {\n  bool showBadge() => true;\n  String crest() => 'cup';\n}\n\nclass Car {}\n\nextension CarBadge on Car {\n  String label() => 'car';\n}\n",
    "lib/club_card.dart": `import 'club.dart';
import 'club_ext.dart';

class ClubCard {
  final ClubType type;
  final Club club;
  ClubCard(this.type, this.club);

  bool build(YouthClub youth, Keeper keeper) {
    final text = type.label();
    final a = club.crest();
    final b = youth.crest();
    keeper.rest();
    ClubTypeBadge.parse('pro');
    return type.showBadge();
  }
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-dart-ext-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a call on a receiver of the extended type, or a subclass, reaches the extension's member", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks
      .filter((l) => l.sourceFile === "lib/club_card.dart" && l.sourceSymbol === "ClubCard.build")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();
    expect(links).toEqual([
      "ClubTypeBadge.parse -> lib/club_ext.dart::ClubTypeBadge.parse",
      "club.crest -> lib/club_ext.dart::crest",
      "keeper.rest -> lib/club_ext.dart::Squad.rest",
      "type.label -> lib/club_ext.dart::ClubTypeBadge.label",
      "type.showBadge -> lib/club_ext.dart::ClubTypeBadge.showBadge",
      "youth.crest -> lib/club_ext.dart::crest",
    ]);
  });
});
