import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Older PHP keeps its code in `.inc` include files; Delphi uses the extension for compiler switches. */
const FILES: Record<string, string> = {
  "garage/index.php": `<?php
include 'lib/cars.inc';
$cars = list_cars();
`,
  "garage/lib/cars.inc": `<?php
function list_cars() {
  global $db;
  return $db->query("SELECT id, plate FROM cars");
}
`,
  "delphi/switches.inc": `{$DEFINE LEAGUE_DEBUG}
{$IFDEF LEAGUE_DEBUG}{$D+}{$ENDIF}
`,
};

describe(".inc include files", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-inc-"));
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

  it("reads a PHP .inc as PHP, so a page's call reaches the function it includes", () => {
    const link = (summary.symbolLinks ?? []).find((l) => l.sourceFile === "garage/index.php" && l.targetSymbol === "list_cars");
    expect(link?.targetFile).toBe("garage/lib/cars.inc");
  });

  it("refuses an .inc with no PHP in it", () => {
    expect(Object.values(summary.fileProjects ?? {}).length >= 0).toBe(true);
    const files = (summary as unknown as { files?: string[] }).files ?? Object.keys(summary.fileProjects ?? {});
    expect(files).not.toContain("delphi/switches.inc");
    expect(files).toContain("garage/lib/cars.inc");
  });
});
