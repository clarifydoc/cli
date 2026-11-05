import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import "./meta.js";

const FILES: Record<string, string> = {
  "pubspec.yaml": "name: league\n",
  "lib/src/club.dart": "void makeClub() {}\nvoid make$Club() {}\n",
  // A namesake the barrel does not export.
  "lib/src/garage.dart": "void makeClub() {}\n",
  "lib/league.dart": "export 'src/club.dart';\n",
  "lib/main.dart": "import 'league.dart';\nvoid go() {\n  makeClub();\n  make$Club();\n}\n",
};

describe("Dart barrel exports", () => {
  let dir: string;
  let links: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-dart-barrel-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    links = (await loadReportSummary(join(dir, "out"))).symbolLinks.map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("brings the names of an exported library into scope for a bare call, never a namesake the barrel lacks", () => {
    expect(links).toContain("makeClub -> lib/src/club.dart::makeClub");
    expect(links).toContain("make$Club -> lib/src/club.dart::make$Club");
    expect(links.filter((l) => l.includes("garage.dart"))).toEqual([]);
  });
});
