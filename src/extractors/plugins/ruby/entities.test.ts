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

describe("Ruby concerns and abstract bases are not tables", () => {
  it("hands a concern's associations to the models that include it", () => {
    const concern = extractWithRegex(`module Scoreable
  extend ActiveSupport::Concern

  included do
    has_many :goals, dependent: :destroy
  end
end`, "app/models/concerns/scoreable.rb", "ruby");
    const base = extractWithRegex(`class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end`, "app/models/application_record.rb", "ruby");
    const match = extractWithRegex(`class Match < ApplicationRecord
  include Scoreable
  belongs_to :league
end`, "app/models/match.rb", "ruby");
    const goal = extractWithRegex(`class Goal < ApplicationRecord
  belongs_to :match
end`, "app/models/goal.rb", "ruby");
    const entityNames = (a: typeof match) => a.classes.filter((c) => c.decorators.includes("entity")).map((c) => c.name);
    expect([...entityNames(concern), ...entityNames(base)]).toEqual([]);
    new RubyEntityExtractor().reconcileProject([concern, base, match, goal]);
    expect(concern.entityRelations ?? []).toEqual([]);
    expect((match.entityRelations ?? []).map((r) => `${r.fromEntity}.${r.fromField} -> ${r.toEntity}`).sort()).toEqual([
      "Match.goals -> Goal",
      "Match.league -> League",
    ]);
  });
});

describe("Ruby concerns named like a model", () => {
  it("gives a namespaced concern's associations to no model that only belongs to the same-named model", () => {
    const concern = extractWithRegex(`module Premium::Concerns::Club
  extend ActiveSupport::Concern

  included do
    has_many :sponsors
  end
end`, "premium/app/models/premium/concerns/club.rb", "ruby");
    const club = extractWithRegex(`class Club < ApplicationRecord
  has_many :players
end`, "app/models/club.rb", "ruby");
    const player = extractWithRegex(`class Player < ApplicationRecord
  belongs_to :club
end`, "app/models/player.rb", "ruby");
    new RubyEntityExtractor().reconcileProject([concern, club, player]);
    const rels = [concern, club, player].flatMap((a) => a.entityRelations ?? []).map((r) => `${r.fromEntity}.${r.fromField} -> ${r.toEntity}`);
    expect(rels.sort()).toEqual(["Club.players -> Player", "Player.club -> Club"]);
  });
});
