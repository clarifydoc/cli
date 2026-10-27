import { describe, it, expect } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const analyze = (src: string, file = "app/controllers/clubs_controller.rb") => extractWithRegex(src, file, "ruby");

describe("Ruby argument origins and ActiveRecord filter fields", () => {
  const src = `class ClubsController < ApplicationController
  before_action :club, only: [:show]

  def show
    Fixtures.new(club_id: params[:club_id]).call
    season = params[:season].to_i
    Standings.for(@club, season)
  end

  private

  def club
    @club = Current.league.clubs.find_by!(slug: params[:id])
    @rival = Club.find(params[:rival_id])
    @coach = Coach.where("club_id = ? AND active = ?", params[:id], true).first
    @kit = Kit.find_by_club_id_and_season(params[:id], params[:season])
  end
end
`;
  const a = analyze(src);

  it("reads the request's merged params, through a local and a conversion, and keyword arguments by name", () => {
    const show = a.classes[0]!.methods.find((m) => m.name === "show")!;
    expect(show.calls.filter((c) => c.argOrigins).map((c) => [c.name, c.argOrigins])).toEqual([
      ["Standings.for", [{ index: 1, origin: { kind: "request-param", name: "season" }, transform: "to_i" }]],
      ["new", [{ index: 0, param: "club_id", origin: { kind: "request-param", name: "club_id" } }]],
    ]);
  });

  it("names the columns a finder, a hash, a placeholder and a dynamic finder filter on", () => {
    expect(a.dataSources.filter((d) => d.whereFields).map((d) => [d.line, d.whereFields!.map((w) => `${w.field}=${w.origin.kind === "request-param" ? w.origin.name : "?"}`)])).toEqual([
      [13, ["slug=id"]],
      [14, ["id=rival_id"]],
      [15, ["club_id=id"]],
      [16, ["club_id=id", "season=season"]],
    ]);
  });
});
