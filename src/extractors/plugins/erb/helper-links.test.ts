import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

describe("ERB links by route helper reach the screen of the route they name", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-erb-helpers-"));
    const files: Record<string, string> = {
      Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n",
      "config/routes.rb": [
        "Rails.application.routes.draw do",
        "  resources :clubs, only: [:show, :edit] do",
        "    resources :players, only: [:index]",
        "  end",
        "  resources :fixtures, as: :games, only: [:show]",
        "end",
        "",
      ].join("\n"),
      "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
      "app/controllers/clubs_controller.rb": "class ClubsController < ApplicationController\n  def show; end\n  def edit; end\nend\n",
      "app/controllers/players_controller.rb": "class PlayersController < ApplicationController\n  def index; end\nend\n",
      "app/controllers/fixtures_controller.rb": "class FixturesController < ApplicationController\n  def show; end\nend\n",
      "app/views/clubs/show.html.erb": "<h1>Club</h1>\n<%= link_to 'Edit', edit_club_path(@club) %>\n<%= link_to 'Squad', club_players_path(@club) %>\n",
      "app/views/clubs/edit.html.erb": "<h1>Edit</h1>\n<%= link_to 'Back', club_path(@club) %>\n<%= link_to 'Old', fixture_path(@game) %>\n",
      "app/views/players/index.html.erb": "<h1>Players</h1>\n<%= link_to 'Club', club_path(@club) %>\n<%= link_to 'Game', game_path(@game) %>\n",
      "app/views/fixtures/show.html.erb": "<h1>Game</h1>\n",
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

  const edges = () => (summary.screenFlow?.edges ?? []).map((e) => `${e.from.replace(/^app\/views\//, "")} -> ${e.to.replace(/^app\/views\//, "")}`);

  it("draws an edge for a plain and a nested helper", () => {
    expect(edges()).toContain("clubs/show.html.erb -> clubs/edit.html.erb");
    expect(edges()).toContain("clubs/edit.html.erb -> clubs/show.html.erb");
    expect(edges()).toContain("clubs/show.html.erb -> players/index.html.erb");
    expect(edges()).toContain("players/index.html.erb -> clubs/show.html.erb");
  });

  it("follows the helper a rename states and none the rename replaced", () => {
    expect(edges()).toContain("players/index.html.erb -> fixtures/show.html.erb");
    // `fixture_path` no longer exists once the resource is `as: :games`: the edit page's link names nothing.
    expect(edges()).not.toContain("clubs/edit.html.erb -> fixtures/show.html.erb");
  });
});
