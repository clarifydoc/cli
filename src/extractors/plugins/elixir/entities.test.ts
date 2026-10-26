import { describe, it, expect } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { ElixirEntityExtractor } from "./entities.js";

describe("Repo.preload reads the association's schema", () => {
  it("types each preloaded association by the schemas declaring it, and leaves an ambiguous one untyped", () => {
    const club = extractWithRegex(`defmodule League.Club do
  use Ecto.Schema

  schema "clubs" do
    field :name, :string
    has_many :players, League.Player
    belongs_to :owner, League.Owner
  end
end`, "lib/league/club.ex", "elixir");
    const cup = extractWithRegex(`defmodule League.Cup do
  use Ecto.Schema

  schema "cups" do
    belongs_to :owner, League.Sponsor
  end
end`, "lib/league/cup.ex", "elixir");
    const service = extractWithRegex(`defmodule League.Clubs do
  alias League.Repo

  def squad(club) do
    club = Repo.preload(club, [:players, owner: :address])
    club
    |> Repo.preload(:players)
  end
end`, "lib/league/clubs.ex", "elixir");
    new ElixirEntityExtractor().reconcileProject([club, cup, service]);
    expect(service.dataSources.filter((d) => d.kind === "database").map((d) => `${d.line} ${d.name} ${d.entity ?? "-"}`)).toEqual([
      "5 Repo.preload(:players) Player",
      "5 Repo.preload(:owner) -",
      "5 Repo.preload(:address) -",
      "7 Repo.preload(:players) Player",
    ]);
  });
});
