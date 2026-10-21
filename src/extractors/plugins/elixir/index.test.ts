import { describe, it, expect } from "vitest";
import "../../registry.js";


describe("Ecto writes and query reads", () => {
  it("reads writes through changesets, structs and pipelines, and reads of a query variable", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const src = `defmodule Plausible.Sites do
  def create(attrs) do
    %Site{}
    |> Site.changeset(attrs)
    |> Repo.insert()
  end

  def update(site, attrs) do
    site |> Site.update_changeset(attrs) |> Repo.update!()
  end

  def remove(site), do: Repo.delete(site)

  def bulk(rows), do: Repo.insert_all(Event, rows)

  def list(player) do
    query = from(s in Site, where: s.player_id == ^player.id)
    Repo.all(query)
  end

  defp execute(query), do: query |> QueryBuilder.build() |> ClickhouseRepo.all(query: query)
end`;
    const a = extractWithRegex(src, "lib/plausible/sites.ex", "elixir");
    expect(a.dataSources.map((d) => `${d.line} ${d.name} ${d.entity ?? "-"} ${d.access ?? "-"}`)).toEqual([
      "5 Repo.insert Site write",
      "9 Repo.update! Site write",
      "12 Repo.delete - write",
      "14 Repo.insert_all Event write",
      "17 from(Site) Site -",
      "18 Repo.all - read",
      "21 Repo.all - read",
    ]);
  });
});
