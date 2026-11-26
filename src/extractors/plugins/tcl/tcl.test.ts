import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyze as analyzeProject } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { FileAnalysis } from "../../../types/analysis.js";

function analyze(src: string, path = "src/league.tcl"): FileAnalysis {
  return extractWithRegex(src, path, "tcl");
}
const fn = (a: FileAnalysis, name: string) => a.functions.find((f) => f.name === name);
const calls = (a: FileAnalysis, name: string) => fn(a, name)?.calls.map((c) => c.name) ?? [];

describe("Tcl procs, classes and calls", () => {
  const a = analyze([
    "# proc ghost {} { lineup }",
    "package require http 2.9",
    "source tests/support/league.tcl",
    "source [file join $dir table.tcl]",
    "",
    "proc ::club::rank {club {points 0} args} {",
    "    set total [score_table $club]",
    "    if {$total > 3} { puts \"high\" }",
    "    foreach p [lineup $club] { sign $p }",
    "    return [::league::format_row $total]; # trailing note",
    "}",
    "",
    "proc sign p {",
    "    puts $p ;# ok",
    "    set name \\{",
    "    bench $p",
    "}",
    "",
    "class Match {",
    "    field home {}",
    "    method kickoff {minute} {",
    "        whistle $minute",
    "    }",
    "}",
    "",
    "start_match {tags {\"final\"}} {",
    "    assert_equal [rank $c] 1",
    "}",
  ].join("\n"));

  it("reads procs with their parameters, defaults and block ends", () => {
    expect(a.functions.map((f) => f.name).sort()).toEqual(["<setup>", "kickoff", "rank", "sign"]);
    expect(fn(a, "rank")!.params).toEqual([
      { name: "club", type: null, defaultValue: null },
      { name: "points", type: null, defaultValue: "0" },
      { name: "args", type: null, defaultValue: null },
    ]);
    expect(fn(a, "rank")!.line).toBe(6);
    expect(fn(a, "rank")!.endLine).toBe(11);
    expect(fn(a, "sign")!.params.map((p) => p.name)).toEqual(["p"]);
    expect(fn(a, "sign")!.endLine).toBe(17);
  });

  it("reads command words as calls, never builtins or comments", () => {
    expect(calls(a, "rank")).toEqual(["score_table", "lineup", "sign", "league::format_row"]);
    expect(calls(a, "sign")).toEqual(["bench"]);
    expect(a.functions.flatMap((f) => f.calls.map((c) => c.name))).not.toContain("lineup ghost");
  });

  it("puts the file's own statements in <setup>", () => {
    const setup = fn(a, "<setup>");
    expect(setup?.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["start_match", "assert_equal", "rank"]));
  });

  it("reads class and method", () => {
    expect(a.classes.map((c) => c.name)).toEqual(["Match"]);
    expect(a.classes[0]!.methods.map((m) => m.name)).toEqual(["kickoff"]);
  });

  it("reads source, and package require is no import", () => {
    expect(a.imports.map((i) => i.source)).toEqual(["tests/support/league.tcl", "table.tcl"]);
  });

  it("owns .tcl and .tm", () => {
    expect(pluginFor("tcl")?.extensions).toEqual([".tcl", ".tm"]);
  });
});

describe("Tcl calls across files", () => {
  const files: Record<string, string> = {
    "tests/support/league.tcl": "proc score_table {club} {\n    return [lineup $club]\n}\nproc lineup {club} {\n    return $club\n}\n",
    "tests/unit/tls.tcl": "proc mint_cert {club} {\n    return $club\n}\n",
    "legacy/league.tcl": "proc score_table {club} {\n    return old\n}\n",
    "tests/unit/table.tcl": [
      "package require tls",
      "source tests/support/league.tcl",
      "proc rank {club} {",
      "    set total [score_table $club]",
      "    return $total",
      "}",
    ].join("\n"),
  };

  it("links a call through the file it sources, not to a same-named proc elsewhere or a file named like a package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-tcl-"));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyzeProject({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    const rows = summary.symbolLinks
      .filter((l) => l.sourceFile.startsWith("tests/") && l.strategy !== "reference")
      .map((l) => `${l.sourceFile}#${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`)
      .sort();
    expect(rows).toEqual([
      "tests/support/league.tcl#score_table -lineup-> tests/support/league.tcl#lineup",
      "tests/unit/table.tcl#rank -score_table-> tests/support/league.tcl#score_table",
    ]);
    await rm(dir, { recursive: true, force: true });
  }, 120_000);
});
