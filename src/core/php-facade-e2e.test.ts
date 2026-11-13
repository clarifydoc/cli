import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Laravel facade proxies its static calls to what the container yields for `getFacadeAccessor()`: the class
 * a registration binds to its token, or the class (or the binding of the interface) its accessor names.
 * A token nothing binds, and a namesake class no registration names, stay unlinked.
 */
const php = (ns: string, body: string, uses: string[] = []): string =>
  ["<?php", `namespace ${ns};`, ...uses.map((u) => `use ${u};`), body, ""].join("\n");

const facade = (ns: string, name: string, accessor: string, uses: string[] = []): string =>
  php(ns, `class ${name} extends Facade { protected static function getFacadeAccessor(): string { return ${accessor}; } }`, [
    "Illuminate\\Support\\Facades\\Facade",
    ...uses,
  ]);

const FILES: Record<string, string> = {
  // token accessor, bound to a closure with a typed return
  "app/Support/Facades/Ledger.php": facade("League\\Support\\Facades", "Ledger", "'ledger'"),
  "app/Support/Ledger.php": php("League\\Support", "class Ledger { public function balance(): int { return 1; } }"),
  // a decoy of the same name in another namespace, never bound
  "app/Other/Ledger.php": php("League\\Other", "class Ledger { public function balance(): int { return 2; } }"),
  // token bound by a class reference, singleton
  "app/Support/Facades/Referee.php": facade("League\\Support\\Facades", "Referee", "'referee'"),
  "app/Support/Referee.php": php("League\\Support", "class Referee { public function whistle(): int { return 1; } }"),
  // token bound by a closure `new`, scoped
  "app/Support/Facades/Scout.php": facade("League\\Support\\Facades", "Scout", "'scout'"),
  "app/Support/Scout.php": php("League\\Support", "class Scout { public function watch(): int { return 1; } }"),
  // a token no registration binds
  "app/Support/Facades/Coach.php": facade("League\\Support\\Facades", "Coach", "'coach'"),
  "app/Support/Coach.php": php("League\\Support", "class Coach { public function train(): int { return 1; } }"),
  // the accessor names a class directly
  "app/Support/Facades/Tickets.php": facade("League\\Support\\Facades", "Tickets", "BoxOffice::class", ["League\\Support\\BoxOffice"]),
  "app/Support/BoxOffice.php": php("League\\Support", "class BoxOffice { public function sell(): int { return 1; } }"),
  // the accessor names an interface whose binding decides
  "app/Support/Facades/Sponsors.php": facade("League\\Support\\Facades", "Sponsors", "SponsorBook::class", ["League\\Support\\SponsorBook"]),
  "app/Support/SponsorBook.php": php("League\\Support", "interface SponsorBook { public function sign(): int; }"),
  "app/Support/PaidSponsorBook.php": php("League\\Support", "class PaidSponsorBook implements SponsorBook { public function sign(): int { return 1; } }"),
  // the token is a class alias of config/app.php
  "app/Support/Facades/Umpire.php": facade("League\\Support\\Facades", "Umpire", "'Umpire'"),
  "app/Support/Umpire.php": php("League\\Support", "class Umpire { public function call(): int { return 1; } }"),
  "config/app.php": [
    "<?php",
    "use League\\Support\\Umpire;",
    "use Illuminate\\Support\\Facades\\Cache;",
    "return ['aliases' => ['Umpire' => Umpire::class, 'Cache' => Cache::class]];",
    "",
  ].join("\n"),
  "app/Providers/LeagueServiceProvider.php": php(
    "League\\Providers",
    [
      "class LeagueServiceProvider {",
      "  public function register() {",
      "    $this->app->bind('ledger', static fn (): Ledger => new Ledger());",
      "    $this->app->singleton('referee', Referee::class);",
      "    $this->app->scoped('scout', function ($app) { return new Scout(); });",
      "    $this->app->bind(SponsorBook::class, PaidSponsorBook::class);",
      "  }",
      "}",
    ].join("\n"),
    ["League\\Support\\Ledger", "League\\Support\\Referee", "League\\Support\\Scout", "League\\Support\\SponsorBook", "League\\Support\\PaidSponsorBook"],
  ),
  "app/Http/Run.php": php(
    "League\\Http",
    [
      "class Run {",
      "  public function go() { return Ledger::balance(); }",
      "  public function ref() { return Referee::whistle(); }",
      "  public function scout() { return Scout::watch(); }",
      "  public function coach() { return Coach::train(); }",
      "  public function sell() { return Tickets::sell(); }",
      "  public function sign() { return Sponsors::sign(); }",
      "  public function call() { return Umpire::call(); }",
      "}",
    ].join("\n"),
    [
      "League\\Support\\Facades\\Ledger",
      "League\\Support\\Facades\\Referee",
      "League\\Support\\Facades\\Scout",
      "League\\Support\\Facades\\Coach",
      "League\\Support\\Facades\\Tickets",
      "League\\Support\\Facades\\Sponsors",
      "League\\Support\\Facades\\Umpire",
    ],
  ),
};

describe("Laravel facades resolve to the class the container yields", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-php-facade-"));
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

  const links = (symbol: string) =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === "app/Http/Run.php" && l.sourceSymbol.endsWith(symbol) && l.relation !== "reference")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol} ${l.confidence} ${l.strategy}`);

  it("a token bound to a closure, a class or a scoped factory reaches the bound class, never a namesake", () => {
    expect(links("go")).toEqual(["Ledger.balance -> app/Support/Ledger.php::Ledger.balance INFERRED di-binding"]);
    expect(links("ref")).toEqual(["Referee.whistle -> app/Support/Referee.php::Referee.whistle INFERRED di-binding"]);
    expect(links("scout")).toEqual(["Scout.watch -> app/Support/Scout.php::Scout.watch INFERRED di-binding"]);
  });

  it("a token that is a config class alias reaches the class it names", () => {
    expect(links("call")).toEqual(["Umpire.call -> app/Support/Umpire.php::Umpire.call INFERRED di-binding"]);
  });

  it("a token no registration binds is left unlinked", () => {
    expect(links("coach")).toEqual([]);
  });

  it("an accessor naming a class reaches it, or the implementation the class's binding says", () => {
    expect(links("sell")).toEqual(["Tickets.sell -> app/Support/BoxOffice.php::BoxOffice.sell INFERRED injection"]);
    expect(links("sign")).toEqual(["Sponsors.sign -> app/Support/PaidSponsorBook.php::PaidSponsorBook.sign INFERRED di-binding"]);
  });
});
