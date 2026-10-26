import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Dart `package:` import names a file: the package its pubspec declares,
 * then the path under its `lib/`. A barrel that only re-exports hands its
 * files on; a package of the repository is reached from a sibling package;
 * a method no imported file holds is no unique-name match (real-repo shape).
 */
const FILES: Record<string, string> = {
  "app/pubspec.yaml": "name: league\n\ndependencies:\n  kit:\n    path: ../kit\n",
  "app/lib/models/club.dart": `class Club {
  void promote() {}
}
`,
  "app/lib/models/models.dart": `export 'club.dart';
`,
  "app/lib/fixtures/fixture.dart": `class Fixture {
  void relegate() {}
}
`,
  "app/lib/screens/table_screen.dart": `import 'package:league/models/models.dart';
import 'package:kit/log.dart';

void promoteClub(club) {
  club.promote();
  Log.info('promoted');
}

void relegateClub(fixture) {
  fixture.relegate();
}
`,
  "kit/pubspec.yaml": "name: kit\n",
  "kit/lib/log.dart": `class Log {
  static void info(String message) {}
}
`,
};

describe("Dart package imports", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-dart-packages-"));
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
    return link ? `${link.targetFile} ${link.targetSymbol} ${link.strategy}` : null;
  };

  it("records the name each pubspec declares", () => {
    expect(summary.subProjects?.find((p) => p.root === "app")?.packageName).toBe("league");
    expect(summary.subProjects?.find((p) => p.root === "kit")?.packageName).toBe("kit");
  });

  it("links a unique method of a file a barrel the caller imports re-exports", () => {
    expect(linkOf("promoteClub", "club.promote")).toBe("app/lib/models/club.dart Club.promote unique-global");
  });

  it("reaches a class of a sibling package the caller imports by name", () => {
    expect(linkOf("promoteClub", "Log.info")).toBe("kit/lib/log.dart Log.info class-name");
  });

  it("leaves a method no imported file holds unlinked", () => {
    expect(linkOf("relegateClub", "fixture.relegate")).toBeNull();
  });
});
