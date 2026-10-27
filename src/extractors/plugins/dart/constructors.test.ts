import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { enableFeatures } from "../../../core/feature-flags.js";

/**
 * A named constructor is reached through its type only (real-repo FP): `SquadEvent.selectPlayer()` builds an event,
 * and never stands for the `selectPlayer` method a value is called with, however few methods share the name.
 */
describe.each(["tree-sitter:dart", "no-tree-sitter:dart"])("Dart named constructors (%s)", (feature) => {
  let dir: string;
  const saved = process.env.CLARIFYDOC_FEATURES;
  const files: Record<string, string> = {
    "pubspec.yaml": "name: league\n",
    "lib/events.dart": "class SquadEvent {\n  const factory SquadEvent.selectPlayer({required int id}) = _Select;\n  const SquadEvent();\n}\n\nclass _Select extends SquadEvent {\n  const _Select({required this.id});\n  final int id;\n}\n",
    "lib/coach.dart": "class Coach {\n  void selectPlayer(int id) {}\n}\n",
    "lib/main.dart": `import 'coach.dart';
import 'events.dart';

void run(dynamic coach) {
  coach.selectPlayer(9);
  final event = SquadEvent.selectPlayer(id: 9);
}
`,
  };
  beforeAll(async () => {
    enableFeatures([feature]);
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-dart-ctor-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  it("links a value's call to the method and the type's call to the constructor", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks
      .filter((l) => l.sourceFile === "lib/main.dart" && l.callName.endsWith("selectPlayer"))
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();
    expect(links).toEqual([
      "SquadEvent.selectPlayer -> lib/events.dart::SquadEvent.selectPlayer",
      "coach.selectPlayer -> lib/coach.dart::Coach.selectPlayer",
    ]);
  });
});
