import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { rubySpec } from "./index.js";
import type { ProjectAnalysis, RouteInfo } from "../../../types/analysis.js";

const routes = (src: string): RouteInfo[] => rubySpec.extractRoutes?.(src.split("\n"), []) ?? [];
const draw = (body: string) => `Rails.application.routes.draw do\n${body}\nend`;
const derived = (r: RouteInfo[]) => r.map((x) => `${x.httpMethod} ${x.path} ${x.derivedName ?? "-"}`);

describe("routes.rb: the helper Rails derives for a route nothing names", () => {
  it("names resources, nested resources, singular resources and namespaced ones", () => {
    const out = routes(draw([
      "  resources :clubs, only: [:index, :show, :new, :edit] do",
      "    resources :players, only: [:index]",
      "  end",
      "  resource :session, only: [:show, :new]",
      "  namespace :admin do",
      "    resources :cars, only: [:index]",
      "  end",
      "  scope '/league' do",
      "    resources :matches, only: [:index]",
      "  end",
      "  resources :sheep, only: [:index, :show]",
    ].join("\n")));
    expect(derived(out)).toEqual([
      "GET /clubs clubs",
      "GET /clubs/:id club",
      "GET /clubs/new new_club",
      "GET /clubs/:id/edit edit_club",
      "GET /clubs/:club_id/players club_players",
      "GET /session/new new_session",
      "GET /session session",
      "GET /admin/cars admin_cars",
      "GET /league/matches matches",
      "GET /sheep sheep_index",
      "GET /sheep/:id sheep",
    ]);
  });

  it("names plain verb routes and root by their static path, and leaves a stated name alone", () => {
    const out = routes(draw([
      "  get 'standings', to: 'tables#show'",
      "  get 'gates/a'",
      "  get 'clubs/:id/badge', to: 'badges#show'",
      "  get 'table', to: 'tables#index', as: :league_table",
      "  resources :fixtures, as: :games, only: [:index]",
      "  root to: 'tables#index'",
    ].join("\n")));
    expect(derived(out)).toEqual([
      "GET /standings standings",
      "GET /gates/a gates_a",
      "GET /clubs/:id/badge -",
      "GET /table -",
      "GET /fixtures -",
      "GET / root",
    ]);
  });

  it("derives nothing inside a concern or a shallow block", () => {
    const out = routes(draw("  concern :rated do\n    get 'ratings', to: 'ratings#index'\n  end\n  shallow do\n    resources :clubs, only: [:index]\n  end"));
    expect(derived(out)).toEqual(["GET /ratings -", "GET /clubs -"]);
  });
});

describe("redirect_to a helper no `as:` names", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-derived-"));
    const files: Record<string, string> = {
      Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n",
      "config/routes.rb": [
        "Rails.application.routes.draw do",
        "  resources :clubs do",
        "    resources :players",
        "  end",
        "  resources :fixtures, as: :games",
        "  get 'standings', to: 'tables#show'",
        "  get 'gates/a'",
        "  get 'gates/b'",
        "  get 'gates/c'",
        "  get 'gates/d'",
        "end",
        "",
      ].join("\n"),
      "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
      "app/controllers/gates_controller.rb": [
        "class GatesController < ApplicationController",
        "  def a",
        "    redirect_to club_players_path(1)",
        "  end",
        "",
        "  def b",
        "    redirect_to standings_path",
        "  end",
        "",
        "  def c",
        "    redirect_to fixtures_path", // the resource is renamed `games`: no such helper
        "  end",
        "",
        "  def d",
        "    redirect_to games_path",
        "  end",
        "end",
        "",
      ].join("\n"),
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const redirects = (path: string) => summary.routeMap.find((r) => r.path === path)?.redirectsTo;

  it("resolves a nested resource's derived helper", () => {
    expect(redirects("/gates/a")).toEqual(["/clubs/:club_id/players"]);
  });
  it("resolves a plain route's derived helper", () => {
    expect(redirects("/gates/b")).toEqual(["/standings"]);
  });
  it("resolves the helper the rename states, and never the one it replaced", () => {
    expect(redirects("/gates/c")).toBeUndefined();
    expect(redirects("/gates/d")).toEqual(["/fixtures"]);
  });
});
