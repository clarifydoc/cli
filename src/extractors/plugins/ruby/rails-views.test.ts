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
