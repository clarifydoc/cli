import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpExtractor } from "./functions-classes.js";
import { LaravelEventResolver } from "./laravel-events.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function fileOf(filePath: string, src: string): Promise<FileAnalysis> {
  const tree = await parseSource(src, "php" as any, filePath);
  const x = new PhpExtractor();
  return { filePath, language: "php", projectId: "league", functions: x.extractFunctions(tree, src), classes: x.extractClasses(tree, src) } as unknown as FileAnalysis;
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
});
