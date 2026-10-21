import { describe, it, expect } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { RubyEntityExtractor } from "./entities.js";

describe("Ruby chain rows through memoizers and instance variables", () => {
  it("types `@agent.update!` by what the filter assigned, through the memoizer it called", () => {
    const player = extractWithRegex(`class Player < ApplicationRecord
  has_many :club_players
end`, "app/models/player.rb", "ruby");
    const club = extractWithRegex(`class Club < ApplicationRecord
  has_many :players
end`, "app/models/club.rb", "ruby");
    const ctl = extractWithRegex(`class Api::AgentsController < Api::BaseController
  before_action :fetch_agent, except: [:index]

  def update
    @agent.update!(agent_params)
  end

  private

  def fetch_agent
    @agent = agents.find(params[:id])
  end

  def agents
    @agents ||= Current.club.players.order_by_full_name.includes(:avatar)
  end
end`, "app/controllers/api/agents_controller.rb", "ruby");
    const analyses = [player, club, ctl];
    new RubyEntityExtractor().reconcileProject(analyses);
    const rows = ctl.dataSources.filter((d) => d.kind === "database").map((d) => `${d.line} ${d.name} ${d.entity ?? "-"}`).sort();
    // `agents.find` is a read on a bare variable — no row per file (an Array reads the same).
    expect(rows).toEqual([
      "15 Current.club.players.order_by_full_name.includes Player",
      "5 @agent.update! Player",
    ]);
  });
});

describe("Ruby service objects are not models", () => {
  it("drops `PlayerService.create` when the project declares PlayerService and it is not a model, and keeps real and undeclared models", () => {
    const player = extractWithRegex(`class Player < ApplicationRecord
end`, "app/models/player.rb", "ruby");
    const service = extractWithRegex(`class PlayerService
  def self.create(attrs)
    Player.create(attrs)
  end
end`, "app/services/player_service.rb", "ruby");
    const ctl = extractWithRegex(`class PlayersController < ApplicationController
  def create
    PlayerService.create(params)
    Player.find(params[:id])
    Billing::Bill.where(paid: true)
  end
end`, "app/controllers/players_controller.rb", "ruby");
    new RubyEntityExtractor().reconcileProject([player, service, ctl]);
    const rows = (a: typeof ctl) => a.dataSources.filter((d) => d.kind === "database").map((d) => `${d.name} ${d.entity ?? "-"}`);
    expect(rows(ctl)).toEqual(["Player.find Player", "Billing::Bill.where Bill"]);
    expect(rows(service)).toEqual(["Player.create Player"]);
  });
});
