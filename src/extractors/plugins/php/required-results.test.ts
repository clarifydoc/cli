import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** A factory a `require_once` brings in: what it is declared to return types the local it initializes. */
const FILES: Record<string, string> = {
  "club.php": `<?php
class Club {
    public function promote() { return 1; }
}
`,
  // A second `promote`: the factory's return type, not the method's name, decides which.
  "car.php": `<?php
class Car {
    public function promote() { return 2; }
}
`,
  "factory.php": `<?php
require_once 'club.php';
function make_club(): Club {
    return new Club();
}
`,
  "main.php": `<?php
require_once 'factory.php';
function run() {
    $c = make_club();
    $c->promote();
}
`,
};

describe("PHP locals typed by a required function's result", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-require-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types `$c = make_club()` by the return type `make_club` declares in the required file", () => {
    const links = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "main.php").map((l) => `${l.callName} -> ${l.targetFile}:${l.targetSymbol}`);
    expect(links.sort()).toEqual(["c.promote -> club.php:Club.promote", "make_club -> factory.php:make_club"]);
  });
});
