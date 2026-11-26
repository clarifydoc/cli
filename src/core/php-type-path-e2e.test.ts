import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A PHP parameter or property typed through a namespace path (`\League\Cup\Fixture $f`) is the class declared in that
 * namespace; a namesake in the caller's own namespace never answers for it, nor does the project's other `Fixture`
 * when the path names a library class.
 */
const php = (ns: string, body: string, uses: string[] = []): string =>
  ["<?php", `namespace ${ns};`, ...uses.map((u) => `use ${u};`), body, ""].join("\n");

const FILES: Record<string, string> = {
  "src/Cup/Fixture.php": php("League\\Cup", "class Fixture { public function kickOff() {} }"),
  "src/Play/Fixture.php": php("League\\Play", "class Fixture { public function kickOff() {} }"),
  "src/Play/ByPath.php": php("League\\Play", "class ByPath { public function go(\\League\\Cup\\Fixture $f) { $f->kickOff(); } }"),
  "src/Play/ByBare.php": php("League\\Play", "class ByBare { public function go(Fixture $f) { $f->kickOff(); } }"),
  "src/Play/ByRelative.php": php("League\\Play", "class ByRelative { public function go(\\League\\Cup\\Fixture|null $f) { $f->kickOff(); } }"),
  "src/Play/ByLibrary.php": php("League\\Play", "class ByLibrary { public function go(\\Vendor\\Lib\\Fixture $f) { $f->kickOff(); } }"),
  "src/Play/ByProperty.php": php("League\\Play", "class ByProperty { private \\League\\Cup\\Fixture $f; public function go() { $this->f->kickOff(); } }"),
  "src/Play/ByCtor.php": php("League\\Play", "class ByCtor { public function __construct(private \\League\\Cup\\Fixture $f) {} public function go() { $this->f->kickOff(); } }"),
};

describe("PHP call linking reads a namespace-path type", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-php-typepath-"));
    const root = join(dir, "app");
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const targets = (file: string): string[] =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === file && l.sourceSymbol !== "(reference)")
      .map((l) => l.targetFile)
      .sort();

  it("a parameter typed by a path reaches that namespace's class, not the caller's namesake", () => {
    expect(targets("src/Play/ByPath.php")).toEqual(["src/Cup/Fixture.php"]);
    expect(targets("src/Play/ByRelative.php")).toEqual(["src/Cup/Fixture.php"]);
  });
  it("a bare name still reaches the caller's own namespace", () => {
    expect(targets("src/Play/ByBare.php")).toEqual(["src/Play/Fixture.php"]);
  });
  it("a path naming a library class links to no project namesake", () => {
    expect(targets("src/Play/ByLibrary.php")).toEqual([]);
  });
  it("a property and a promoted constructor parameter typed by a path reach that namespace's class", () => {
    expect(targets("src/Play/ByProperty.php")).toEqual(["src/Cup/Fixture.php"]);
    expect(targets("src/Play/ByCtor.php")).toEqual(["src/Cup/Fixture.php"]);
  });
});
