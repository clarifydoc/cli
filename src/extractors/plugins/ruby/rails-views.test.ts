import { describe, it, expect } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { RailsViewResolver } from "./rails-views.js";

describe("Rails actions render their Jbuilder view", () => {
  it("links an action to the view its controller path and name select, and reads the view's own queries", () => {
    const ctl = extractWithRegex(`class Api::V1::ClubsController < Api::BaseController
  def index
    @clubs = Current.league.clubs
  end

  def show
    @club = Club.find(params[:id])
  end
end`, "app/controllers/api/v1/clubs_controller.rb", "ruby");
    const index = extractWithRegex(`json.array! @clubs do |club|
  json.id club.id
  json.players club.players.where(active: true)
end`, "app/views/api/v1/clubs/index.json.jbuilder", "ruby");
    const other = extractWithRegex(`json.partial! 'api/v1/models/club', club: @club`, "app/views/api/v1/garages/show.json.jbuilder", "ruby");
    const links = new RailsViewResolver().resolve([ctl, index, other]);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`)).toEqual([
      "Api::V1::ClubsController.index -> app/views/api/v1/clubs/index.json.jbuilder::<setup>",
    ]);
    expect(index.dataSources.filter((d) => d.kind === "database").map((d) => d.name)).toEqual(["club.players.where"]);
  });
});

describe("Rails explicit renders and Jbuilder partials", () => {
  it("links `render :x` / `render 'dir/x'` to that template and a view to the partials it renders", () => {
    const ctl = extractWithRegex(`class Api::V1::ClubsController < Api::BaseController
  def update
    @club.update!(club_params)
    render :show
  end

  def transfer
    render 'api/v1/players/index'
  end

  def table
    render json: { ok: true }
  end
end`, "app/controllers/api/v1/clubs_controller.rb", "ruby");
    const show = extractWithRegex(`json.partial! 'api/v1/models/club', formats: [:json], club: @club`, "app/views/api/v1/clubs/show.json.jbuilder", "ruby");
    const players = extractWithRegex(`json.array! @players, partial: 'player', as: :player`, "app/views/api/v1/players/index.json.jbuilder", "ruby");
    const club = extractWithRegex(`json.id club.id\njson.sponsors club.sponsors.where(active: true)`, "app/views/api/v1/models/_club.json.jbuilder", "ruby");
    const player = extractWithRegex(`json.id player.id\njson.goals player.goals.count`, "app/views/api/v1/players/_player.json.jbuilder", "ruby");
    const links = new RailsViewResolver().resolve([ctl, show, players, club, player]);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetFile}`).sort()).toEqual([
      "<setup> -> app/views/api/v1/models/_club.json.jbuilder",
      "<setup> -> app/views/api/v1/players/_player.json.jbuilder",
      "Api::V1::ClubsController.transfer -> app/views/api/v1/players/index.json.jbuilder",
      "Api::V1::ClubsController.update -> app/views/api/v1/clubs/show.json.jbuilder",
    ]);
  });
});
