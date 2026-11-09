import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Instance variables typed by what assigns them: in the method itself, in a `before_action` filter of the
 * controller or an ancestor (`only:`/`except:` respected), or through a memoizing reader. `Match` declares
 * the same honour methods as the `Honours` concern: an untyped `@club` must never land on it.
 */
const FILES: Record<string, string> = {
  "Gemfile": `source "https://rubygems.org"
gem "rails", "~> 7.1"
`,
  "config/routes.rb": `Rails.application.routes.draw do
  resources :clubs, only: [:show, :update, :destroy] do
    member do
      post :recognise
      post :promote
    end
  end
  resources :players, only: [:show, :update]
  namespace :api do
    resources :matches, only: [:update]
  end
end
`,
  "db/schema.rb": `ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  create_table "clubs", force: :cascade do |t|
    t.string "name"
    t.string "honour_list"
    t.bigint "league_id"
  end
  create_table "players", force: :cascade do |t|
    t.string "name"
    t.string "honour_list"
    t.bigint "club_id"
  end
  create_table "matches", force: :cascade do |t|
    t.string "honour_list"
  end
  create_table "leagues", force: :cascade do |t|
    t.string "name"
  end
end
`,
  "app/models/application_record.rb": `class ApplicationRecord < ActiveRecord::Base
  primary_abstract_class
end
`,
  "app/models/concerns/honours.rb": `module Honours
  extend ActiveSupport::Concern

  def update_honours(honours)
    update!(honour_list: honours)
  end

  def award_honours(honours)
    update!(honour_list: honours)
  end
end
`,
  "app/models/club.rb": `class Club < ApplicationRecord
  include Honours
  belongs_to :league
  has_many :players
end
`,
  "app/models/player.rb": `class Player < ApplicationRecord
  include Honours
  belongs_to :club
end
`,
  "app/models/league.rb": `class League < ApplicationRecord
  has_many :clubs
end
`,
  "app/models/match.rb": `class Match < ApplicationRecord
  # Decoy: same-named methods on another model.
  def update_honours(honours)
    update!(honour_list: honours)
  end

  def award_honours(honours)
    update!(honour_list: honours)
  end
end
`,
  "app/controllers/application_controller.rb": `class ApplicationController < ActionController::Base
  def current_league
    @current_league ||= League.find(session[:league_id])
  end
end
`,
  "app/controllers/clubs_controller.rb": `class ClubsController < ApplicationController
  before_action :set_club, only: [:update, :recognise]

  def show
    @player = Player.find(params[:id])
    @player.award_honours(params[:honours])
  end

  def update
    @club.update_honours(params[:honours])
  end

  def recognise
    @club.reload.award_honours(params[:honours])
  end

  def promote
    @club = current_league.clubs.find(params[:id])
    @club.award_honours(params[:honours])
  end

  def destroy
    # set_club does not run for destroy: @club is untyped here.
    @club.update_honours(params[:honours])
  end

  private

  def set_club
    @club = Club.find(params[:id])
  end
end
`,
  "app/controllers/players_controller.rb": `class PlayersController < ApplicationController
  def show
    player.award_honours(params[:honours])
  end

  def update
    player.reload.update_honours(params[:honours])
  end

  private

  def player
    @player ||= Player.find(params[:id])
  end
end
`,
  "app/controllers/api/base_controller.rb": `module Api
  class BaseController < ApplicationController
    before_action :set_match, except: [:index]

    private

    def set_match
      @match = Match.find(params[:id])
    end
  end
end
`,
  "app/controllers/api/matches_controller.rb": `module Api
  class MatchesController < BaseController
    def update
      @match.award_honours(params[:honours])
    end
  end
end
`,
  "app/controllers/transfers_controller.rb": `class TransfersController < ApplicationController
  before_action :set_club

  def create
    # The action reassigns from the request: what set_club stated no longer holds.
    @club = params[:club]
    @club.award_honours(params[:honours])
  end

  def update
    @club.update_honours(params[:honours])
  end

  private

  def set_club
    @club = Club.find(params[:id])
  end
end
`,
  "app/controllers/swaps_controller.rb": `class SwapsController < ApplicationController
  def update
    @side = Club.find(params[:id]) if params[:club]
    @side = Match.find(params[:id]) if params[:match]
    @side.update_honours(params[:honours])
  end
end
`,
  "app/services/honours_service.rb": `class HonoursService
  # @param player [Player]
  def call(player)
    player.award_honours(["captaincy"])
  end

  def untyped(club)
    club.award_honours(["captaincy"])
  end
end
`,
  "app/services/sorbet_service.rb": `class SorbetService
  sig { params(player: Player).void }
  def call(player)
    player.award_honours(["captaincy"])
  end
end
`,};

describe("Ruby instance variables typed by what assigns them", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-ivars-"));
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

  const linksOf = (symbol: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.callName === callName).map((l) => l.targetSymbol);
  const writes = (route: string) =>
    new Set((summary.dataFlows ?? []).filter((f) => f.entryKind === "route" && f.entryLabel === route && f.effect === "db-write").map((f) => f.resource));

  it("types a variable the action assigns itself", () => {
    expect(linksOf("ClubsController.show", "player.award_honours")).toEqual(["Honours.award_honours"]);
    expect(writes("GET /clubs/:id")).toEqual(new Set(["Player"]));
  });

  it("types a variable a before_action filter of the controller assigns, for the actions it runs before", () => {
    expect(linksOf("ClubsController.update", "club.update_honours")).toEqual(["Honours.update_honours"]);
    expect(writes("PATCH /clubs/:id")).toEqual(new Set(["Club"]));
  });

  it("keeps the type through a step that returns the record itself", () => {
    expect(linksOf("ClubsController.recognise", "club.reload.award_honours")).toEqual(["Honours.award_honours"]);
    expect(writes("POST /clubs/:id/recognise")).toEqual(new Set(["Club"]));
  });

  it("follows an association chain off an inherited reader", () => {
    expect(linksOf("ClubsController.promote", "club.award_honours")).toEqual(["Honours.award_honours"]);
    expect(writes("POST /clubs/:id/promote")).toEqual(new Set(["Club"]));
  });

  it("leaves a variable untyped in an action its filter does not run before", () => {
    expect(linksOf("ClubsController.destroy", "club.update_honours")).toEqual([]);
    expect(writes("DELETE /clubs/:id")).toEqual(new Set());
  });

  it("types a variable an ancestor controller's filter assigns, except: respected", () => {
    expect(linksOf("MatchesController.update", "match.award_honours")).toEqual(["Match.award_honours"]);
  });

  it("types a call on a memoizing reader by what the reader assigns", () => {
    expect(linksOf("PlayersController.show", "player.award_honours")).toEqual(["Honours.award_honours"]);
    expect(linksOf("PlayersController.update", "player.reload.update_honours")).toEqual(["Honours.update_honours"]);
  });

  it("lets an untyped assignment in the action override what a filter states", () => {
    expect(linksOf("TransfersController.create", "club.award_honours")).toEqual([]);
    expect(linksOf("TransfersController.update", "club.update_honours")).toEqual(["Honours.update_honours"]);
  });

  it("leaves a conditional assignment untyped", () => {
    expect(linksOf("SwapsController.update", "side.update_honours")).toEqual([]);
  });

  it("types a parameter only by a stated type", () => {
    expect(linksOf("HonoursService.call", "player.award_honours")).toEqual(["Honours.award_honours"]);
    expect(linksOf("SorbetService.call", "player.award_honours")).toEqual(["Honours.award_honours"]);
    expect(linksOf("HonoursService.untyped", "club.award_honours")).toEqual([]);
  });
});
