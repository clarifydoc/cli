import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpExtractor } from "./functions-classes.js";
import { LaravelEventResolver } from "./laravel-events.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function fileOf(filePath: string, src: string): Promise<FileAnalysis> {
  const tree = await parseSource(src, "php" as any, filePath);
  const x = new PhpExtractor();
  const declaredNamespace = /^namespace\s+([\w\\]+);/m.exec(src)?.[1];
  const imports = [...src.matchAll(/^use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/gm)].map((m) => ({ source: m[1]!, specifiers: [m[2] ?? m[1]!.split("\\").pop()!] }));
  return { filePath, language: "php", projectId: "league", functions: x.extractFunctions(tree, src), classes: x.extractClasses(tree, src), imports, declaredNamespace } as unknown as FileAnalysis;
}

describe("Laravel events → listeners", () => {
  it("links each dispatching callable to every listener whose handle() takes the event", async () => {
    const analyses = await Promise.all([
      fileOf("app/Http/Controllers/MatchController.php", `<?php
namespace App\\Http\\Controllers;
use App\\Events\\MatchPlayed;
class MatchController {
  public function finish($id) {
    $match = Match::find($id);
    event(new MatchPlayed($match));
    return response()->json($match);
  }
  public function abandon($id) {
    MatchAbandoned::dispatch($id);
  }
  public function show($id) {
    return new MatchResource(Match::find($id));
  }
}`),
      fileOf("app/Listeners/UpdateLeagueTable.php", `<?php
namespace App\\Listeners;
use App\\Events\\MatchPlayed;
class UpdateLeagueTable {
  public function handle(MatchPlayed $event): void { $event->match->club->increment('points'); }
}`),
      fileOf("app/Listeners/NotifySupporters.php", `<?php
class NotifySupporters {
  public function handle(\\App\\Events\\MatchPlayed|MatchAbandoned $event) {}
}`),
      fileOf("app/Http/Middleware/Authenticate.php", `<?php
class Authenticate {
  public function handle(Request $request, Closure $next) { return $next(new Request()); }
}`),
    ]);
    const links = new LaravelEventResolver().resolve(analyses);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetSymbol} (${l.callName})`).sort()).toEqual([
      "MatchController.abandon -> NotifySupporters.handle (MatchAbandoned.dispatch)",
      "MatchController.finish -> NotifySupporters.handle (event(MatchPlayed))",
      "MatchController.finish -> UpdateLeagueTable.handle (event(MatchPlayed))",
    ]);
  });

  it("links a dispatched job to its handle(), by a name only one class carries", async () => {
    const analyses = await Promise.all([
      fileOf("app/Http/Controllers/TransferController.php", `<?php
class TransferController {
  public function sign() { SettleFee::dispatch(1); }
  public function loan() { dispatch(new ScoutReport(2)); }
  public function sell() { Garage::dispatch(3); }
}`),
      fileOf("app/Jobs/SettleFee.php", `<?php
namespace App\\Jobs;
class SettleFee implements ShouldQueue { public function handle() {} }`),
      fileOf("app/Jobs/ScoutReport.php", `<?php
class ScoutReport { public function handle(Scouts $scouts) {} }`),
      fileOf("app/A/Garage.php", `<?php
class Garage { public function handle() {} }`),
      fileOf("app/B/Garage.php", `<?php
class Garage { public function handle() {} }`),
    ]);
    const links = new LaravelEventResolver().resolve(analyses);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetSymbol} (${l.callName})`).sort()).toEqual([
      "TransferController.loan -> ScoutReport.handle (dispatch(ScoutReport))",
      "TransferController.sign -> SettleFee.handle (SettleFee.dispatch)",
    ]);
  });

  it("a job name two classes share resolves by the use import or the namespace, never by the leaf", async () => {
    const analyses = await Promise.all([
      fileOf("app/Http/Controllers/ClubController.php", `<?php
namespace App\\Http\\Controllers;
use App\\Jobs\\SyncClub;
class ClubController {
  public function sync() { dispatch(new SyncClub(1)); }
  public function full() { dispatch(new \\App\\Legacy\\SyncClub(1)); }
}`),
      fileOf("app/Http/Controllers/PlayerController.php", `<?php
namespace App\\Http\\Controllers;
class PlayerController {
  public function sync() { dispatch(new SyncClub(1)); }
}`),
      fileOf("app/Jobs/SyncClub.php", `<?php
namespace App\\Jobs;
class SyncClub { public function handle() {} }`),
      fileOf("app/Legacy/SyncClub.php", `<?php
namespace App\\Legacy;
class SyncClub { public function handle() {} }`),
    ]);
    const links = new LaravelEventResolver().resolve(analyses);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetFile}`).sort()).toEqual([
      "ClubController.full -> app/Legacy/SyncClub.php",
      "ClubController.sync -> app/Jobs/SyncClub.php",
    ]);
  });
});
