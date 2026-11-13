import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A PHP `Garage::park()` names the class through what its file states — its own file, a `use` (or the alias
 * or namespace prefix it gives), its own namespace, a fully qualified name — never a namesake in another
 * namespace, nor a project class the file's namespace does not hold.
 */
const php = (ns: string | null, body: string, uses: string[] = []): string =>
  ["<?php", ...(ns ? [`namespace ${ns};`] : []), ...uses.map((u) => `use ${u};`), body, ""].join("\n");

const FILES: Record<string, string> = {
  "src/Garage/Garage.php": php("App\\Garage", "class Garage { public static function park() { return 1; } }"),
  "src/Other/Garage.php": php("App\\Other", "class Garage { public static function park() { return 2; } public static function wash() { return 3; } }"),
  "src/Lib/Vendor.php": php("Lib", "class Vendor { public static function ship() { return 1; } }"),
  "src/Run/ViaUse.php": php("App\\Run", "class ViaUse { public function go() { return Garage::park(); } }", ["App\\Other\\Garage"]),
  "src/Run/ViaAlias.php": php("App\\Run", "class ViaAlias { public function go() { return Shed::park(); } }", ["App\\Other\\Garage as Shed"]),
  "src/Run/ViaFqn.php": php("App\\Run", "class ViaFqn { public function go() { return \\App\\Other\\Garage::park(); } }"),
  "src/Run/ViaPrefix.php": php("App\\Run", "class ViaPrefix { public function go() { return Other\\Garage::wash(); } }", ["App\\Other"]),
  "src/Run/NoUse.php": php("App\\Run", "class NoUse { public function go() { return Garage::park(); } }"),
  "src/Run/NoUseVendor.php": php("App\\Run", "class NoUseVendor { public function go() { return Vendor::ship(); } }"),
  "src/Garage/SameNs.php": php("App\\Garage", "class SameNs { public function go() { return Garage::park(); } }"),
  "src/Garage/SameFile.php": php("App\\Garage", "class Pit { public static function fill() { return 1; } }\nclass SameFile { public function go() { return Pit::fill(); } }"),
  "src/global_a.php": php(null, "class Wheel { public static function spin() { return 1; } }"),
  "src/global_b.php": php(null, "function run() { return Wheel::spin(); }"),
};

describe("PHP static calls bind through the file's evidence", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-php-static-"));
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
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();

  it("a `use`, its alias, a namespace prefix and a full name reach the class they name", () => {
    expect(targets("src/Run/ViaUse.php")).toEqual(["Garage.park -> src/Other/Garage.php::Garage.park"]);
    expect(targets("src/Run/ViaAlias.php")).toEqual(["Shed.park -> src/Other/Garage.php::Garage.park"]);
    expect(targets("src/Run/ViaPrefix.php")).toEqual(["Other\\Garage.wash -> src/Other/Garage.php::Garage.wash"]);
    expect(targets("src/Run/ViaFqn.php")).toEqual(["\\App\\Other\\Garage.park -> src/Other/Garage.php::Garage.park"]);
  });

  it("the own namespace, the own file and the global namespace reach their class", () => {
    expect(targets("src/Garage/SameNs.php")).toEqual(["Garage.park -> src/Garage/Garage.php::Garage.park"]);
    expect(targets("src/Garage/SameFile.php")).toEqual(["Pit.fill -> src/Garage/SameFile.php::Pit.fill"]);
    expect(targets("src/global_b.php")).toEqual(["Wheel.spin -> src/global_a.php::Wheel.spin"]);
  });

  it("a name no use, namespace or full name reaches is left unlinked", () => {
    expect(targets("src/Run/NoUse.php")).toEqual([]);
    expect(targets("src/Run/NoUseVendor.php")).toEqual([]);
  });
});
