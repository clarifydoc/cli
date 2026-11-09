import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A Rails concern's write on its own receiver (`update!` bare in `module Badgeable`), included by
 * Club and Player: each route reaches the table of the model it calls the concern method on — never
 * the other includer's. Stadium declares a namesake method of its own and includes nothing.
 */
describe("a concern's access bound to the receiver at each call site, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-mixin-self-"));
    const root = join(dir, "league");
    const files: Record<string, string[]> = {
      "Gemfile": ["source 'https://rubygems.org'", "gem 'rails', '~> 7.1'"],
      "app/models/application_record.rb": ["class ApplicationRecord < ActiveRecord::Base", "  self.abstract_class = true", "end"],
      "app/models/concerns/badgeable.rb": [
        "module Badgeable",
        "  extend ActiveSupport::Concern",
        "",
        "  included do",
        "    after_create { update!(badge_list: []) }",
        "  end",
        "",
        "  def update_badges(badges)",
        "    update!(badge_list: badges)",
        "  end",
        "",
        "  def add_badge(badge)",
        "    update_badges(badge_list + [badge])",
        "  end",
        "end",
      ],
      "app/models/club.rb": ["class Club < ApplicationRecord", "  include Badgeable", "", "  def rebrand(badge)", "    update_badges([badge])", "  end", "end"],
      "app/models/player.rb": ["class Player < ApplicationRecord", "  include Badgeable", "end"],
      "app/models/stadium.rb": ["class Stadium < ApplicationRecord", "  def update_badges(badges)", "    badges", "  end", "end"],
      "app/controllers/application_controller.rb": ["class ApplicationController < ActionController::Base", "end"],
      "app/controllers/concerns/badge_concern.rb": ["module BadgeConcern", "  def create", "    model.update_badges(params[:badges])", "  end", "end"],
      "app/controllers/club_badges_controller.rb": [
        "class ClubBadgesController < ApplicationController",
        "  include BadgeConcern",
        "  before_action :fetch_club",
        "",
        "  def model",
        "    @model ||= @club",
        "  end",
        "",
        "  def fetch_club",
        "    @club = Club.find(params[:club_id])",
        "  end",
        "end",
      ],
      "app/controllers/player_badges_controller.rb": [
        "class PlayerBadgesController < ApplicationController",
        "  include BadgeConcern",
        "  before_action :fetch_player",
        "",
        "  def model",
        "    @model ||= @player",
        "  end",
        "",
        "  def fetch_player",
        "    @player = Player.find(params[:player_id])",
        "  end",
        "end",
      ],
      "app/controllers/clubs_controller.rb": ["class ClubsController < ApplicationController", "  def rebrand", "    club = Club.find(params[:id])", "    club.rebrand(params[:badge])", "  end", "end"],
      "app/controllers/players_controller.rb": ["class PlayersController < ApplicationController", "  def badges", "    player = Player.find(params[:id])", "    player.add_badge(params[:badge])", "  end", "end"],
      "app/controllers/stadiums_controller.rb": ["class StadiumsController < ApplicationController", "  def badges", "    stadium = Stadium.find(params[:id])", "    stadium.update_badges(params[:badges])", "  end", "end"],
      "config/routes.rb": [
        "Rails.application.routes.draw do",
        "  resources :clubs, only: [] do",
        "    member do",
        "      post :rebrand",
        "    end",
        "    resources :badges, only: [:create], controller: 'club_badges'",
        "  end",
        "  resources :players, only: [] do",
        "    member do",
        "      post :badges",
        "    end",
        "    resources :badges, only: [:create], controller: 'player_badges'",
        "  end",
        "  resources :stadiums, only: [] do",
        "    member do",
        "      post :badges",
        "    end",
        "  end",
        "end",
      ],
      "db/schema.rb": [
        "ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do",
        '  create_table "clubs", force: :cascade do |t|',
        '    t.string "badge_list"',
        "  end",
        '  create_table "players", force: :cascade do |t|',
        '    t.string "badge_list"',
        "  end",
        '  create_table "stadiums", force: :cascade do |t|',
        '    t.string "badge_list"',
        "  end",
        "end",
      ],
    };
    for (const [path, lines] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), lines.join("\n") + "\n");
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes only the table of the model each route calls the concern method on", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const writes = [...new Set((summary.dataFlows ?? [])
      .filter((f) => f.entryKind === "route" && f.effect === "db-write")
      .map((f) => `${f.entryLabel} ${f.resource}`))].sort();
    expect(writes).toEqual([
      // `model.update_badges`, the controller's reader typed by `@club = Club.find(…)`.
      "POST /clubs/:club_id/badges Club",
      // `club.rebrand` → `update_badges` on the model's own instance.
      "POST /clubs/:id/rebrand Club",
      "POST /players/:id/badges Player",
      "POST /players/:player_id/badges Player",
    ]);
  });

  it("keeps a concern's class-body access on every including model", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const calls = (summary.dataAccessGraph?.edges ?? [])
      .filter((e) => e.source === "file::app/models/concerns/badgeable.rb")
      .flatMap((e) => e.calls.map((c) => `${c.line} ${c.name}`))
      .sort();
    // The `included do … end` callback runs in each includer's body; the method's `update!` (line 9)
    // reaches the database under the concern's name, no table: only a call site says which model it runs on.
    expect(calls).toEqual(["5 Club.update!", "5 Player.update!", "9 Badgeable.update!"]);
  });
});
