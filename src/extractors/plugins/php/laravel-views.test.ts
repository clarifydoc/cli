import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A Laravel app whose route groups name their controller namespace and route
 * names, with same-named controllers in two namespaces and Blade forms that
 * post to named routes (real-repo FP: 286 route anchors guessed between
 * same-named controllers, and no Blade form reached its controller).
 */
const FILES: Record<string, string> = {
  "composer.json": JSON.stringify({ require: { "laravel/framework": "^10.0" } }),
  "routes/web.php": `<?php
Route::group(['namespace' => 'League\\\\Http\\\\Controllers\\\\Club', 'prefix' => 'clubs', 'as' => 'clubs.'], function () {
    Route::get('', ['uses' => 'IndexController@index', 'as' => 'index']);
    Route::get('show/{club}', ['uses' => 'ShowController@show', 'as' => 'show']);
    Route::post('update/{club}', ['uses' => 'EditController@update', 'as' => 'update']);
});
Route::group(['namespace' => 'League\\\\Http\\\\Controllers\\\\Player', 'prefix' => 'players', 'as' => 'players.'], function () {
    Route::get('show/{player}', ['uses' => 'ShowController@show', 'as' => 'show']);
});
`,
  "app/Http/Controllers/Club/IndexController.php": `<?php
namespace League\\Http\\Controllers\\Club;
class IndexController { public function index() { return view('clubs.index'); } }
`,
  "app/Http/Controllers/Club/ShowController.php": `<?php
namespace League\\Http\\Controllers\\Club;
class ShowController { public function show($club) { return view('clubs.show'); } }
`,
  "app/Http/Controllers/Club/EditController.php": `<?php
namespace League\\Http\\Controllers\\Club;
class EditController { public function update($club) { return redirect()->route('clubs.show', $club); } }
`,
  "app/Http/Controllers/Player/ShowController.php": `<?php
namespace League\\Http\\Controllers\\Player;
class ShowController { public function show($player) { return view('players.show'); } }
`,
  "resources/views/clubs/show.blade.php": `@extends('layout')
@section('content')
<form method="POST" action="{{ route('clubs.update', [$club->id]) }}">
  @csrf
  <button type="submit">Save</button>
</form>
<a href="{{ route('players.show', [$club->captain_id]) }}">Captain</a>
@endsection
`,
};

describe("Laravel named routes, qualified controllers and Blade requests", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-laravel-views-"));
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

  it("names each route with its group's prefix and qualifies its controller", () => {
    const rows = (summary.routeMap ?? []).map((r) => `${r.httpMethod} ${r.path} ${r.name} ${r.owner}`).sort();
    expect(rows).toEqual([
      "GET /clubs clubs.index League\\Http\\Controllers\\Club\\IndexController",
      "GET /clubs/show/{club} clubs.show League\\Http\\Controllers\\Club\\ShowController",
      "GET /players/show/{player} players.show League\\Http\\Controllers\\Player\\ShowController",
      "POST /clubs/update/{club} clubs.update League\\Http\\Controllers\\Club\\EditController",
    ]);
  });

  it("anchors each route on the controller of its namespace, never the same-named other", () => {
    const anchors = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceSymbol.startsWith("route:"))
      .map((l) => `${l.sourceSymbol} -> ${l.targetFile} ${l.confidence}`).sort();
    expect(anchors).toContain("route:GET /clubs/show/{club} -> app/Http/Controllers/Club/ShowController.php INFERRED");
    expect(anchors).toContain("route:GET /players/show/{player} -> app/Http/Controllers/Player/ShowController.php INFERRED");
  });

  it("links a Blade form and link to the action their named route runs", () => {
    const links = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === "resources/views/clubs/show.blade.php")
      .map((l) => `${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`).sort();
    expect(links).toEqual([
      "players_show -> app/Http/Controllers/Player/ShowController.php::ShowController.show",
      "post_clubs_update -> app/Http/Controllers/Club/EditController.php::EditController.update",
    ]);
  });
});
