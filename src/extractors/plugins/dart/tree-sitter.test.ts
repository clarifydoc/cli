import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { loadDartReader } from "./tree-sitter.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ParsedStructure } from "../../../types/language-plugin.js";

let readDart: (source: string) => ParsedStructure;
beforeAll(async () => {
  readDart = await loadDartReader();
});

const SQUAD = `import 'package:league/league.dart';

class SquadService extends BaseService {
  final SquadRepo repo;

  SquadService(this.repo) : super(name: 'squad');

  SquadService.empty() : this(MemoryRepo());

  factory SquadService.fromEnv() => SquadService(locateRepo());

  Future<List<Player>> load(int id) async {
    final squad = await repo.find(id);
    this.repo.cache.clear();
    final report = Club(id: 7).squad();
    getIt<Coach>().brief(squad);
    void note(Player p) { log(p.name); }
    squad.players.forEach((p) { note(p); });
    return repo.find(id).players.toList();
  }

  int get size => repo.count();
}

void registerAll(void Function() onDone) {
  final handler = const Pipeline().addMiddleware(logRequests()).addHandler(router);
  buffer..write('a')..flush();
}
`;

describe("Dart through tree-sitter", () => {
  it("reads functions, constructors and local functions with their spans, a local one owning its calls", () => {
    const parsed = readDart(SQUAD);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["SquadService", 6, 6],
      ["empty", 8, 8],
      ["fromEnv", 10, 10],
      ["load", 12, 20],
      ["note", 17, 17],
      ["registerAll", 25, 28],
    ]);
    expect(parsed.functions.find((f) => f.name === "note")!.calls.map((c) => c.name)).toEqual(["log"]);
  });

  it("names calls as the Dart patterns do, and the chains and constructions they cannot read", () => {
    const fns = readDart(SQUAD).functions;
    const calls = (name: string) => fns.find((f) => f.name === name)!.calls.map((c) => c.name);
    expect(calls("SquadService")).toEqual(["super"]);
    expect(calls("empty")).toEqual(["this", "MemoryRepo"]);
    expect(calls("load")).toEqual([
      "repo.find",
      "this.repo.cache.clear",
      "Club",
      "Club.squad",
      "getIt<Coach>().brief",
      "getIt<Coach>",
      "squad.players.forEach",
      "note",
      // A field read after a call ends the chain; the method is named by the last two names, as the patterns name it.
      "players.toList",
    ]);
    expect(fns.find((f) => f.name === "load")!.calls.find((c) => c.name === "getIt<Coach>().brief")).toMatchObject({ receiverType: "Coach" });
    // A cascade's method is read bare (`write` is stdlib noise, dropped as the patterns drop it).
    expect(calls("registerAll")).toEqual(["Pipeline.addMiddleware().addHandler", "Pipeline.addMiddleware", "Pipeline", "logRequests", "flush"]);
  });

  it("names no object pattern, and a dot shorthand's member alone (real-repo FP)", () => {
    const calls = (body: string) => readDart(`void f() {\n${body}\n}\n`).functions[0]!.calls.map((c) => c.name);
    expect(calls("switch (result) { case Error<Fixture>(): retry(); case Ok(value: final v): show(v); }")).toEqual(["retry", "show"]);
    expect(calls("final kickoff = KickoffTime(.parse(raw));")).toEqual(["KickoffTime", "parse"]);
    expect(calls("final squad = players[0].transfer();")).toEqual([]);
  });

  it("counts the errors of a file the grammar cannot read, so core keeps the regex reading", () => {
    expect(readDart("void f( {\n").syntaxErrors).toBeGreaterThan(0);
  });
});

/**
 * Where the two readings of a fixture differ, and why the parser's is the one to keep: `file → function →
 * [calls only the patterns record, calls only the parser records]`. A method on a call's result or a construction
 * is named as the chain from it (`Navigator.of().pushNamed`), which the linker types through declared return
 * types; the patterns read a wrapped chain's steps bare (`addMiddleware`) and skip the rest. A constructor's
 * initializer list is its own (`: service = locateService()`, `: super(key: key)`, which the linker joins to the
 * base class's constructor).
 */
const KNOWN: Record<string, Record<string, [string[], string[]]>> = {
  "test-fixtures/sample-dart-app/server/api.dart": {
    main: [["addMiddleware", "addHandler"], ["Pipeline.addMiddleware().addMiddleware", "Pipeline.addMiddleware().addMiddleware().addHandler", "Pipeline.addMiddleware"]],
  },
  "test-fixtures/sample-dart-app/lib/main.dart": {
    "PlayerDetailScreen.PlayerDetailScreen": [[], ["super"]],
    "SampleApp.SampleApp": [[], ["super"]],
  },
  "test-fixtures/sample-dart-app/lib/screens/player_list_screen.dart": {
    "PlayerListScreen.PlayerListScreen": [[], ["super"]],
    "_PlayerListScreenState._PlayerListScreenState": [[], ["locateService"]],
  },
  "test-fixtures/sample-dart-app/lib/services/player_service.dart": {
    "PlayerService.fetchPlayers": [[], ["data.map().toList"]],
  },
};

describe("Dart: tree-sitter and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/**/*.dart", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do, but where it is listed as better`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readDart(src);
      expect(parsed.syntaxErrors).toBe(0);
      const shape = (a: ReturnType<typeof extractWithRegex>) => [
        ...a.functions.map((f) => ({ name: f.name, line: f.line, endLine: f.endLine, calls: f.calls.map((c) => c.name) })),
        ...a.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine, calls: m.calls.map((x) => x.name) }))),
      ];
      const regex = shape(extractWithRegex(src, rel, "dart"));
      const tree = shape(extractWithRegex(src, rel, "dart", undefined, parsed));
      expect(tree.map(({ calls: _, ...span }) => span)).toEqual(regex.map(({ calls: _, ...span }) => span));
      const differences: Record<string, [string[], string[]]> = {};
      regex.forEach((fn, i) => {
        const b = tree[i]!.calls;
        const onlyA = fn.calls.filter((c) => !b.includes(c));
        const onlyB = b.filter((c) => !fn.calls.includes(c));
        if (onlyA.length + onlyB.length > 0) differences[fn.name] = [onlyA, onlyB];
      });
      expect(differences).toEqual(KNOWN[rel] ?? {});
    });
  }
});
