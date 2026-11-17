import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import "./meta.js";

/**
 * A bare read of a getter inside the class that declares it (or inherits it) is a call of that getter, so the
 * getter's own calls join the reading method's chain: `int n = squadSize;` reaches what `get squadSize` requests.
 * Never a parameter or local of the same name, a field, or a getter of another class.
 */
const FILES: Record<string, string> = {
  "pubspec.yaml": "name: garage\ndependencies:\n  dio: ^5.0.0\n",
  "lib/squad.dart": `import 'package:dio/dio.dart';

class SquadService {
  int get squadSize { Dio().get('/api/squads/size'); return 11; }
  String get endpoint => '/api/squads';
  int get roster => squadSize + 1;
  Future<void> load() async {
    final n = squadSize;
    print('$squadSize');
    await Dio().get(endpoint);
  }
  Future<void> withParam(int squadSize) async {
    final m = squadSize;
  }
  Future<void> withLocal() async {
    var endpoint = 'x';
    print(endpoint);
    for (final squadSize in [1, 2]) { print(squadSize); }
  }
  Future<void> withBare() async {
    String squadSize;
    squadSize = "x";
    print(squadSize);
  }
  void viaGetter() { print(roster); }
  void member(Other o) { print(o.squadSize); }
}

class SquadBoard extends SquadService {
  void show() { print(squadSize); }
}

mixin SquadMixin {
  String get tag { Dio().get('/api/squads/tag'); return 'tag'; }
  void use() { print(tag); }
}

int get topSize { Dio().get('/api/squads/top'); return 1; }
void useTop() { print(topSize); }
`,
  "lib/other.dart": `class Other {
  int get squadSize => 9;
  void read() { print(squadSize); }
}

class Plain {
  int squadSize = 0;
  void read() { print(squadSize); }
}
`,
};

describe("Dart bare getter reads", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-dart-bare-getters-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reaches = (file: string, from: string) =>
    summary.symbolLinks.filter((l) => l.sourceFile === file && l.sourceSymbol === from && l.relation !== "reference").map((l) => `${l.callName}->${l.targetFile}::${l.targetSymbol}`);

  it("links a read of the class's own getter, from a method, another getter and a string interpolation", () => {
    expect(reaches("lib/squad.dart", "SquadService.load")).toContain("squadSize->lib/squad.dart::SquadService.squadSize");
    expect(reaches("lib/squad.dart", "SquadService.load")).toContain("endpoint->lib/squad.dart::SquadService.endpoint");
    expect(reaches("lib/squad.dart", "SquadService.roster")).toContain("squadSize->lib/squad.dart::SquadService.squadSize");
    expect(reaches("lib/squad.dart", "SquadService.viaGetter")).toContain("roster->lib/squad.dart::SquadService.roster");
  });

  it("reads an inherited getter, a mixin's own and a top-level one", () => {
    expect(reaches("lib/squad.dart", "SquadBoard.show")).toContain("squadSize->lib/squad.dart::SquadService.squadSize");
    expect(reaches("lib/squad.dart", "SquadMixin.use")).toContain("tag->lib/squad.dart::SquadMixin.tag");
    expect(reaches("lib/squad.dart", "useTop")).toContain("topSize->lib/squad.dart::topSize");
  });

  it("never links a parameter, a local, a field or another class's getter", () => {
    expect(reaches("lib/squad.dart", "SquadService.withParam")).toEqual([]);
    expect(reaches("lib/squad.dart", "SquadService.withLocal")).toEqual([]);
    expect(reaches("lib/squad.dart", "SquadService.withBare")).toEqual([]);
    // A member of a typed receiver is that class's getter (getter-reads.test.ts), never the reading class's own.
    expect(reaches("lib/squad.dart", "SquadService.member")).toEqual(["o.squadSize->lib/other.dart::Other.squadSize"]);
    expect(reaches("lib/other.dart", "Other.read").filter((x) => x.includes("SquadService"))).toEqual([]);
  });
});
