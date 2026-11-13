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
  // One file opening two namespaces: each class answers to its own, not the first one's.
  "src/Multi/Pair.php": "<?php\nnamespace App\\Home {\n class Kit { public static function pack() { return 1; } }\n}\nnamespace App\\Away {\n class Shirt { public static function wash() { return 2; } }\n class Away2 { public function go() { return Shirt::wash(); } }\n}\n",
  "src/Multi/Stmt.php": "<?php\nnamespace App\\Home;\nclass Cap { public static function fit() { return 1; } }\nnamespace App\\Away;\nclass Boot { public static function lace() { return 2; } }\n",
  "src/Run/ViaWrongUse.php": php("App\\Run", "class ViaWrongUse { public function go() { return Shirt::wash(); } }", ["App\\Home\\Shirt"]),
  "src/Run/ViaRightUse.php": php("App\\Run", "class ViaRightUse { public function go() { return Shirt::wash(); } }", ["App\\Away\\Shirt"]),
  "src/Run/ViaFqnSecond.php": php("App\\Run", "class ViaFqnSecond { public function go() { return \\App\\Away\\Boot::lace(); } }"),
  "src/Run/ViaFqnStmtFirst.php": php("App\\Run", "class ViaFqnStmtFirst { public function go() { return \\App\\Away\\Cap::fit(); } }"),
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

  it("a class of a file that opens several namespaces answers to its own", () => {
    expect(targets("src/Run/ViaWrongUse.php")).toEqual([]);
    expect(targets("src/Run/ViaRightUse.php")).toEqual(["Shirt.wash -> src/Multi/Pair.php::Shirt.wash"]);
    expect(targets("src/Run/ViaFqnSecond.php")).toEqual(["\\App\\Away\\Boot.lace -> src/Multi/Stmt.php::Boot.lace"]);
    expect(targets("src/Run/ViaFqnStmtFirst.php")).toEqual([]);
    // The caller's own namespace is the class around the call.
    expect(targets("src/Multi/Pair.php")).toEqual(["Shirt.wash -> src/Multi/Pair.php::Shirt.wash"]);
  });
});
