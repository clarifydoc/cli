import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

/** A Dart local initialised by a bare call is typed by that function's declared return type. */
describe("Dart bare-call locals", () => {
  let dir: string;
  const files: Record<string, string> = {
    "pubspec.yaml": "name: league\n",
    "lib/club.dart": "class Club {\n  void save() {}\n}\n\nClub topClub() => Club();\n",
    "lib/car.dart": "class Car {\n  void save() {}\n}\n",
    "lib/own.dart": `class Striker {
  void shoot() {}
}

class Keeper {
  void shoot() {}
}

class StrikerFactory {
  static Striker create() => Striker();
}

Future<Striker> loadStriker() async => Striker();
Keeper owned() => Keeper();

Future<void> same() async {
  var s = await loadStriker();
  s.shoot();
}

void twice() {
  if (DateTime.now().isUtc) {
    final p = owned();
    p.shoot();
  } else {
    final p = StrikerFactory.create();
    p.shoot();
  }
}
`,
    "lib/svc.dart": `import 'club.dart';
import 'car.dart';

class Service {
  Club pick() => Club();
  Future<Club> fetch() async => Club();
  Car other() => Car();
  void a() { final x = pick(); x.save(); }
  Future<void> b() async { final y = await fetch(); y.save(); }
  void c() { final w = topClub(); w.save(); }
  void d() { final z = other(); z.save(); }
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-dart-bare-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links each receiver to its own return type's member, never the namesake", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks
      .filter((l) => l.callName.endsWith(".save"))
      .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();
    expect(links).toEqual([
      "Service.a x.save -> lib/club.dart::Club.save",
      "Service.b y.save -> lib/club.dart::Club.save",
      "Service.c w.save -> lib/club.dart::Club.save",
      "Service.d z.save -> lib/car.dart::Car.save",
    ]);
  });

  it("types a local by a function of its own file, and never lets a bare call displace another declaration's type", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks
      .filter((l) => l.sourceFile === "lib/own.dart" && l.callName.endsWith(".shoot"))
      .map((l) => `${l.callName} -> ${l.targetSymbol}`)
      .sort();
    expect(links).toEqual(["p.shoot -> Striker.shoot", "s.shoot -> Striker.shoot"]);
  });
});
