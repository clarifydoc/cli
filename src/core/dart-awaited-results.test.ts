import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Dart local bound to an awaited call takes the type inside the `Future` the
 * callee declares, as a C# local takes the one inside its `Task`. `Player.save`
 * is the namesake that must never be reached: two classes declare `save`, so
 * only the type links the call.
 */
const FILES: Record<string, string> = {
  "pubspec.yaml": "name: league\n",
  "lib/club_repo.dart": `import 'dart:async';

class Club {
  void save() {}
}

class Player {
  void save() {}
}

class ClubRepo {
  Future<Club> find(int id) async {
    return Club();
  }

  FutureOr<Club> cached(int id) {
    return Club();
  }

  Future<List<Club>> all() async {
    return [];
  }
}
`,
  "lib/main.dart": `import 'club_repo.dart';

Future<void> promote(ClubRepo repo) async {
  final club = await repo.find(1);
  club.save();
}

Future<void> restore(ClubRepo repo) async {
  final club = await repo.cached(1);
  club.save();
}

Future<void> archive(ClubRepo repo) async {
  final clubs = await repo.all();
  clubs.save();
}

void pending(ClubRepo repo) {
  final club = repo.find(1);
  club.save();
}
`,
};

describe("Dart awaited results", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-dart-awaited-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName === callName);
    return link ? `${link.targetFile} ${link.targetSymbol}` : null;
  };

  it("types a local by what an awaited Future holds", () => {
    expect(linkOf("promote", "club.save")).toBe("lib/club_repo.dart Club.save");
  });

  it("reads FutureOr the same way", () => {
    expect(linkOf("restore", "club.save")).toBe("lib/club_repo.dart Club.save");
  });

  it("leaves a Future of a list, and a Future nothing awaits, untyped", () => {
    expect(linkOf("archive", "clubs.save")).toBeNull();
    expect(linkOf("pending", "club.save")).toBeNull();
  });
});
