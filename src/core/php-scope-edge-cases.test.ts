import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Two PHP scope edge cases: a free function of a later namespace in a file that opens several reads its own
 * namespace (not the file's first), and a facade whose accessor returns `static::TOKEN` takes the constant from
 * the trait it uses.
 */
const php = (ns: string, body: string, uses: string[] = []): string =>
  ["<?php", `namespace ${ns};`, ...uses.map((u) => `use ${u};`), body, ""].join("\n");

const FILES: Record<string, string> = {
  "composer.json": `{"name":"league/app"}\n`,
  // free functions: two namespaces in one file, the same `money` in two others
  "src/club_money.php": "<?php\nnamespace League\\Club;\n\nfunction money() { return 1; }\n",
  "src/garage_money.php": "<?php\nnamespace League\\Garage;\n\nfunction money() { return 2; }\n",
  "src/caller.php": [
    "<?php",
    "namespace League\\Club {",
    "    function first() { return 0; }",
    "}",
    "namespace League\\Garage {",
    "    function pay() { return money(); }",
    "}",
    "",
  ].join("\n"),
  // facades
  "src/HasPitchToken.php": php("League\\Support", "trait HasPitchToken { const TOKEN = 'pitch'; }"),
  "src/Facades/Pitch.php": php(
    "League\\Support\\Facades",
    "class Pitch extends Facade { use HasPitchToken; protected static function getFacadeAccessor() { return static::TOKEN; } }",
    ["Illuminate\\Support\\Facades\\Facade", "League\\Support\\HasPitchToken"],
  ),
  "src/Facades/Lost.php": php(
    "League\\Support\\Facades",
    "class Lost extends Facade { protected static function getFacadeAccessor() { return static::NOWHERE; } }",
    ["Illuminate\\Support\\Facades\\Facade"],
  ),
  "src/Pitch.php": php("League\\Support", "class Pitch { public function roll(): int { return 1; } }"),
  "src/Lost.php": php("League\\Support", "class Lost { public function find(): int { return 1; } }"),
  "src/Other/Pitch.php": php("League\\Other", "class Pitch { public function roll(): int { return 2; } }"),
  "src/Provider.php": php(
    "League\\Providers",
    "class Provider { public function register() { $this->app->bind('pitch', Pitch::class); $this->app->bind('lost', Lost::class); } }",
    ["League\\Support\\Pitch", "League\\Support\\Lost"],
  ),
  "src/Run.php": php(
    "League\\Http",
    "class Run { public function roll() { return Pitch::roll(); } public function find() { return Lost::find(); } }",
    ["League\\Support\\Facades\\Pitch", "League\\Support\\Facades\\Lost"],
  ),
};

describe("PHP scope edge cases", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-php-scope-"));
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

  const from = (file: string, symbol: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === file && l.sourceSymbol.endsWith(symbol) && l.relation !== "reference")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);

  it("a function of a later namespace calls the `money` of that namespace, not the file's first", () => {
    expect(from("src/caller.php", "pay")).toEqual(["money -> src/garage_money.php::money"]);
  });

  it("a facade's `static::TOKEN` declared by a trait it uses names its token", () => {
    expect(from("src/Run.php", "roll")).toEqual(["Pitch.roll -> src/Pitch.php::Pitch.roll"]);
  });

  it("a constant declared nowhere names no token", () => {
    expect(from("src/Run.php", "find")).toEqual([]);
  });
});
