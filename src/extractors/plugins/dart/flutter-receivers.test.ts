import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

/** What a State's `widget`, a getter, a local's call, a mixin and a generic constructor reach — each with a namesake decoy. */
describe("Dart receivers (Flutter)", () => {
  let dir: string;
  const files: Record<string, string> = {
    "pubspec.yaml": "name: league\ndependencies:\n  flutter:\n    sdk: flutter\n  retrofit: ^4.0.0\n",
    "lib/repo.dart": `class ClubRepo {
  void load() {}
}
class CarRepo {
  void load() {}
}
class Squad {
  void retire() {}
}
class Garage {
  void retire() {}
}
class Holder {
  final Squad squad = Squad();
}
class Badge<T> {
  Badge();
  void show() {}
}
class Player {
  void save() {}
}
class Roster {
  Player first() => Player();
  Player get captain => Player();
}
class Staff {
  void save() {}
}
mixin Trainable {
  void train() {}
}
class Coach with Trainable {
  void run() {}
}
class Mechanic {
  void train() {}
}
`,
    "lib/page.dart": `import 'package:flutter/material.dart';
import 'repo.dart';

class ClubPage extends StatefulWidget {
  final ClubRepo repo;
  final Holder holder;
  const ClubPage(this.repo, this.holder);
  State<ClubPage> createState() => _ClubPageState();
}

class _ClubPageState extends State<ClubPage> {
  final Roster s = Roster();
  void act(Coach coach) async {
    widget.repo.load();
    widget.holder.squad.retire();
    this.widget.holder.squad.retire();
    var b = Badge<int>();
    final c = s.first();
    c.save();
    s.captain.save();
    coach.train();
  }
  Widget build(BuildContext context) => Scaffold();
}
`,
    "lib/api.dart": `import 'package:retrofit/retrofit.dart';
import 'package:dio/dio.dart';
part 'api.g.dart';

@RestApi(baseUrl: 'https://example.com/api')
abstract class ClubApi {
  factory ClubApi(Dio dio) = _ClubApi;
  @GET('/clubs')
  Future<List<String>> getClubs();
  @POST('/clubs/{id}')
  Future<void> rename(@Path() String id, @Body() String name);
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-dart-flutter-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types a State's widget, a getter, a local initialised by a call, a mixin member and a generic constructor", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks
      .filter((l) => l.sourceFile === "lib/page.dart")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
    expect(links).toEqual(expect.arrayContaining([
      "widget.repo.load -> lib/repo.dart::ClubRepo.load",
      "widget.holder.squad.retire -> lib/repo.dart::Squad.retire",
      "this.widget.holder.squad.retire -> lib/repo.dart::Squad.retire",
      "Badge -> lib/repo.dart::Badge.Badge",
      "c.save -> lib/repo.dart::Player.save",
      "s.captain.save -> lib/repo.dart::Player.save",
      "coach.train -> lib/repo.dart::Trainable.train",
    ]));
  });

  it("reads retrofit's annotated methods as requests of the @RestApi class", async () => {
    const a = JSON.parse(await readFile(join(dir, "out", "lib/api.dart.json"), "utf8"));
    expect(a.dataSources.map((d: { name: string; target: string; line: number }) => `${d.name} ${d.target} @${d.line}`)).toEqual(["GET /clubs @9", "POST /clubs/{id} @11"]);
    expect(a.httpClientRegistrations[0]).toMatchObject({ client: "ClubApi", base: { key: "https://example.com/api" } });
  });
});
