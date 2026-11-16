import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** A file opening several PHP namespaces: each free function answers to the namespace it is declared in, not the first one's. */
const FILES: Record<string, string> = {
  "src/helpers.php": [
    "<?php",
    "namespace App\\League {",
    "    function standings() { return 1; }",
    "    function league_clean() { return wash(); }",
    "}",
    "namespace App\\Garage {",
    "    function standings() { return 2; }",
    "    function park() { return standings(); }",
    "    function clean() { return wash(); }",
    "}",
    "",
  ].join("\n"),
  "src/globals.php": "<?php\nnamespace App\\League {\n    function first() { return 1; }\n}\nnamespace {\n    function shared() { return 2; }\n}\n",
  "src/lib.php": "<?php\nnamespace App\\Garage;\nfunction wash() { return 3; }\n",
  "src/main.php": [
    "<?php",
    "namespace App\\Garage;",
    "require 'helpers.php';",
    "function run() { return \\App\\Garage\\standings(); }",
    "function other() { return \\App\\League\\standings(); }",
    "function global_call() { return \\shared(); }",
    "",
  ].join("\n"),
};

describe("PHP free functions in a multi-namespace file", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-php-multi-fn-"));
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

  const lines = (file: string): string[] =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === file && l.sourceSymbol !== "(reference)")
      .map((l) => `${l.sourceSymbol}: ${l.callName} -> ${l.targetFile}:${l.targetLine}`)
      .sort();

  it("a bare call inside the second namespace reaches that namespace's function", () => {
    expect(lines("src/helpers.php").filter((l) => l.includes(": standings"))).toEqual(["park: standings -> src/helpers.php:7"]);
  });

  it("a function of the global namespace in a multi-namespace file is the global one, not the first namespace's", () => {
    expect(lines("src/main.php").filter((l) => l.includes(": \\shared"))).toEqual(["global_call: \\shared -> src/globals.php:6"]);
  });

  it("a bare call into another file reads the namespace of the function around it", () => {
    // `clean` is in App\\Garage, where `wash` lives; `league_clean` is in App\\League, which has none.
    expect(lines("src/helpers.php").filter((l) => l.includes(": wash"))).toEqual(["clean: wash -> src/lib.php:3"]);
  });

  it("a fully qualified call reaches the namespace it names, first or later", () => {
    expect(lines("src/main.php").filter((l) => !l.includes(": \\shared"))).toEqual([
      "other: \\App\\League\\standings -> src/helpers.php:3",
      "run: \\App\\Garage\\standings -> src/helpers.php:7",
    ]);
  });
});
