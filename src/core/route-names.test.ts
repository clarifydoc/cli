import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** A redirect that names a route by the name the framework registered it under (`RouteInfo.name`). */
const RAILS: Record<string, string> = {
  Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n",
  "config/routes.rb": `Rails.application.routes.draw do
  get 'standings', to: 'clubs#table', as: :league_table
  post 'clubs', to: 'clubs#create'
  get 'league_table', to: 'players#decoy'
end
`,
  "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
  "app/controllers/clubs_controller.rb": `class ClubsController < ApplicationController
  def table; end
  def create
    redirect_to league_table_path
  end
end
`,
  "app/controllers/players_controller.rb": "class PlayersController < ApplicationController\n  def decoy; end\nend\n",
};

const ADONIS: Record<string, string> = {
  "package.json": JSON.stringify({ dependencies: { "@adonisjs/core": "^6.0.0" } }),
  "start/routes.ts": `import router from '@adonisjs/core/services/router'
const ClubsController = () => import('#controllers/clubs_controller')
router.get('/standings', [ClubsController, 'table']).as('league.table')
router.post('/clubs', [ClubsController, 'store'])
router.get('/league/table', [ClubsController, 'decoy'])
`,
  "app/controllers/clubs_controller.ts": `export default class ClubsController {
  async table() { return [] }
  async decoy() { return [] }
  async store({ response }: any) {
    return response.redirect().toRoute('league.table')
  }
}
`,
};

const LARAVEL: Record<string, string> = {
  "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }),
  "routes/web.php": `<?php
use App\\Http\\Controllers\\ClubController;
use Illuminate\\Support\\Facades\\Route;
Route::get('/standings', [ClubController::class, 'table'])->name('league.table');
Route::post('/clubs', [ClubController::class, 'store']);
Route::get('/league/table', [ClubController::class, 'decoy']);
`,
  "app/Http/Controllers/ClubController.php": `<?php
namespace App\\Http\\Controllers;
class ClubController extends Controller
{
    public function table() { return view('table'); }
    public function decoy() { return view('decoy'); }
    public function store()
    {
        return redirect()->route('league.table');
    }
}
`,
};

const DJANGO: Record<string, string> = {
  "requirements.txt": "django\n",
  "league/urls.py": `from django.urls import path
from . import views
urlpatterns = [
    path("standings/", views.table, name="league_table"),
    path("clubs/new/", views.create),
    path("league/table/", views.decoy),
]
`,
  "league/views.py": `from django.shortcuts import redirect
from django.urls import reverse

def table(request):
    return None

def decoy(request):
    return None

def create(request):
    return redirect(reverse("league_table"))
`,
};

async function scan(files: Record<string, string>, label: string): Promise<{ summary: ProjectAnalysis; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `cd-route-names-${label}-`));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
    await writeFile(join(dir, "app", rel), text);
  }
  await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("a redirect to a route by name", () => {
  const cleanups: Array<() => Promise<void>> = [];
  let rails: ProjectAnalysis;
  let adonis: ProjectAnalysis;
  let laravel: ProjectAnalysis;
  let django: ProjectAnalysis;
  beforeAll(async () => {
    const [r, a, l, d] = await Promise.all([scan(RAILS, "rails"), scan(ADONIS, "adonis"), scan(LARAVEL, "laravel"), scan(DJANGO, "django")]);
    rails = r.summary;
    adonis = a.summary;
    laravel = l.summary;
    django = d.summary;
    cleanups.push(r.cleanup, a.cleanup, l.cleanup, d.cleanup);
  }, 120_000);
  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  it("follows a Rails helper named by `as:`, not the route whose path spells it", () => {
    const post = (rails.routeMap ?? []).find((r) => r.httpMethod === "POST" && r.path === "/clubs");
    expect(post?.redirectsTo).toEqual(["/standings"]);
  });

  it("follows an Adonis `toRoute` to the route `.as()` named", () => {
    const post = (adonis.routeMap ?? []).find((r) => r.httpMethod === "POST" && r.path === "/clubs");
    expect(post?.redirectsTo).toEqual(["/standings"]);
  });

  it("follows a Laravel `redirect()->route()` and a Django `reverse()`", () => {
    const l = (laravel.routeMap ?? []).find((r) => r.httpMethod === "POST" && r.path === "/clubs");
    expect(l?.redirectsTo).toEqual(["/standings"]);
    const d = (django.routeMap ?? []).find((r) => r.path.includes("clubs/new"));
    expect(d?.redirectsTo?.map((p) => p.replace(/^\//, ""))).toEqual(["standings/"]);
  });
});
