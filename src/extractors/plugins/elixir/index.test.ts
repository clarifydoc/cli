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

  it("reads wrapped from(…), piped schemas, wrapped bulk writes and audited verbs; a query-building call is no schema", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const src = `defmodule League.Transfers do
  def agents(club) do
    Repo.all(
      from(
        a in Scouting.Agent,
        where: a.club_id == ^club.id
      )
    )
  end

  def fetch(id) do
    Scouting.Agent
    |> Repo.get!(id)
  end

  def by_name(name), do: Club |> Repo.get_by(name: name)
  def first_team(club), do: Repo.one(Squads.first_team_query(club))

  def purge(club) do
    Repo.delete_all(
      from(t in Transfer, where: t.club_id == ^club.id)
    )
  end

  def sign(attrs), do: Repo.insert_with_audit!(Contract.changeset(%Contract{}, attrs), "signed")

  def history(site) do
    from(e in Base.events_query(site))
    from(i in Imported.Base.query_imported("imported_kits", site))
  end
end`;
    const a = extractWithRegex(src, "lib/league/transfers.ex", "elixir");
    expect(a.dataSources.map((d) => `${d.line} ${d.name} ${d.entity ?? "-"} ${d.access ?? "-"}`)).toEqual([
      "4 from(Scouting.Agent) Agent -",
      "13 Repo.get! Agent read",
      "16 Repo.get_by Club read",
      "17 Repo.one - read",
      "21 from(Transfer) Transfer write",
      "25 Repo.insert_with_audit! Contract write",
      "29 from(\"imported_kits\") imported_kits -",
    ]);
  });
});

describe("Oban jobs", () => {
  it("consumes on a worker's perform and enqueues where a job of it is inserted", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const worker = extractWithRegex(`defmodule League.Workers.SendFixtureReport do
  use Oban.Worker,
    queue: :fixture_reports

  @impl Oban.Worker
  def perform(%Oban.Job{args: args}) do
    :ok
  end

  def enqueue(club_id) do
    %{club_id: club_id}
    |> new()
    |> Oban.insert()
  end
end`, "lib/workers/send_fixture_report.ex", "elixir");
    expect(worker.dataSources.map((d) => `${d.kind} ${d.target} @${d.line}`)).toEqual(["queue-consume SendFixtureReport @6", "queue-publish SendFixtureReport @13"]);
    const scheduler = extractWithRegex(`defmodule League.Workers.ScheduleReports do
  def schedule(club) do
    SendFixtureReport.new(%{club_id: club.id},
      scheduled_at: next_monday()
    )
    |> Oban.insert!()
  end

  def export(args), do: {:ok, Oban.insert!(League.Workers.ExportSquad.new(args))}

  def import(club, opts) do
    club
    |> Map.new()
    |> League.Workers.ImportSquad.new(opts)
    |> Oban.insert()
  end
end`, "lib/workers/schedule_reports.ex", "elixir");
    expect(scheduler.dataSources.filter((d) => d.kind.startsWith("queue")).map((d) => `${d.kind} ${d.target} @${d.line}`)).toEqual([
      "queue-publish SendFixtureReport @6",
      "queue-publish ExportSquad @9",
      "queue-publish ImportSquad @15",
    ]);
  });
});

describe("Elixir outgoing HTTP", () => {
  it("reads Req, HTTPoison and Finch requests with their URL and verb", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const a = extractWithRegex(`defmodule League.Clients do
  @scores_url "https://scores.example.com/api/live"

  def purge(zone_id, options) do
    case Req.post("https://cdn.example.com/zone/#{zone_id}/purge", options) do
      {:ok, _} -> :ok
    end
  end

  def download do
    this_month_url = "https://geo.example.com/kits.mmdb"
    HTTPoison.get!(this_month_url)
  end

  def live, do: Req.get!(@scores_url)
  def raw(url, headers, body), do: Finch.build(:post, url, headers, body)
  def check(url), do: Req.request(url: url, method: :head)
end`, "lib/league/clients.ex", "elixir");
    expect(a.dataSources.filter((d) => d.kind === "api-call").map((d) => `${d.name} -> ${d.target} @${d.line}`)).toEqual([
      "POST https://cdn.example.com/zone/{zone_id}/purge -> https://cdn.example.com/zone/{zone_id}/purge @5",
      "GET https://geo.example.com/kits.mmdb -> https://geo.example.com/kits.mmdb @12",
      "GET https://scores.example.com/api/live -> https://scores.example.com/api/live @15",
      "Finch.build -> null @16",
      "Req.request -> null @17",
    ]);
  });
});
