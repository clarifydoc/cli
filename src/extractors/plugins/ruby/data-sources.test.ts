import { describe, it, expect } from "vitest";
import { rubySpec } from "./index.js";

/** Run the spec's ActiveRecord data-source extractor over a Ruby snippet. */
function dbSources(src: string) {
  const lines = src.split("\n");
  return (rubySpec.extractDataSources?.(lines, []) ?? []).filter((d) => d.kind === "database");
}

/** Run the spec's outbound-HTTP extractor over a Ruby snippet. */
function apiCalls(src: string) {
  const lines = src.split("\n");
  return (rubySpec.extractDataSources?.(lines, []) ?? []).filter((d) => d.kind === "api-call");
}

describe("rubySpec.extractDataSources — ActiveRecord", () => {
  it("captures finders/queries and resolves the entity from the model receiver", () => {
    const ds = dbSources(`
      class MatchesController < ApplicationController
        def show
          @match  = Match.find_authorized params[:id], current_club_id
          @others = Match.where(referee_id: @match.referee_id).order(:date)
          club    = Club.find(current_club_id)
        end
      end
    `);
    const byName = Object.fromEntries(ds.map((d) => [d.name, d]));
    expect(byName["Match.find_authorized"]).toMatchObject({ kind: "database", entity: "Match" });
    expect(byName["Match.where"]).toMatchObject({ entity: "Match" });
    expect(byName["Club.find"]).toMatchObject({ entity: "Club" });
    // The chained `.order(:date)` shares the line but has a lowercase relation
    // receiver — it must NOT produce a second source.
    expect(ds.filter((d) => d.name.endsWith(".order"))).toHaveLength(0);
  });

  it("captures writes (create!/update/destroy) the same way", () => {
    const ds = dbSources(`
      Match.create!(create_params)
      Car.update_all(active: false)
      GarageCar.destroy_all
    `).map((d) => d.name);
    expect(ds).toEqual(
      expect.arrayContaining(["Match.create!", "Car.update_all", "GarageCar.destroy_all"]),
    );
  });

  it("captures raw-SQL finders on a model receiver (find_by_sql / count_by_sql)", () => {
    const ds = dbSources(`
      rows  = Car.find_by_sql([sql, bindings])
      total = Goal.count_by_sql([sql, bindings])
    `);
    const byName = Object.fromEntries(ds.map((d) => [d.name, d]));
    // find_by_sql matches the generic `find_` finder; count_by_sql is explicit.
    expect(byName["Car.find_by_sql"]).toMatchObject({ entity: "Car" });
    expect(byName["Goal.count_by_sql"]).toMatchObject({ entity: "Goal" });
  });

  it("resolves namespaced models to their bare entity name", () => {
    const ds = dbSources(`x = League::MatchReport.where(season: 2026).first`);
    expect(ds.find((d) => d.name === "League::MatchReport.where")).toMatchObject({
      entity: "MatchReport",
    });
  });

  it("ignores stdlib constants and non-query methods", () => {
    const ds = dbSources(`
      now   = Time.now
      blob  = File.delete(path)
      cfg   = JSON.parse(body)
      total = Reports.generate_pdf(data)   # capitalised, but not an AR method
      log   = Rails.logger.info("hi")
    `);
    expect(ds).toHaveLength(0);
  });

  it("classifies AR reads vs writes via the access field", () => {
    const ds = dbSources(`
      rows = Match.where(active: true)
      Match.create!(create_params)
      Car.update_all(active: false)
      one = Club.find(id)
    `);
    const byName = Object.fromEntries(ds.map((d) => [d.name, d.access]));
    expect(byName["Match.where"]).toBe("read");
    expect(byName["Club.find"]).toBe("read");
    expect(byName["Match.create!"]).toBe("write");
    expect(byName["Car.update_all"]).toBe("write");
  });

  it("emits an instance/relation chain as an entity-less candidate for the project join", () => {
    // Lowercase / @ivar receivers carry no model name per file: the row goes
    // out without an entity and `RubyEntityExtractor.reconcileProject` joins it
    // to the association's target or the model the variable is named after —
    // or drops it. A read on a bare variable (`matches.each`) is no access.
    const ds = dbSources(`
      @match.update(params)
      matches.each { |a| a.save }
      self.scope.where(x: 1)
      Current.club.conversations.find_by!(display_id: 3)
    `);
    expect(ds.map((d) => [d.name, d.entity ?? null, d.access])).toEqual([
      ["@match.update", null, "write"],
      ["a.save", null, "write"],
      ["self.scope.where", null, "read"],
      ["Current.club.conversations.find_by!", null, "read"],
    ]);
  });

  it("does not match inside comments", () => {
    expect(dbSources(`# Match.where(foo) is just documentation`)).toHaveLength(0);
  });

  it("records an instance save as a write — `save!` is how a built record is persisted", () => {
    const ds = dbSources(`
      @match.save!
      player.save
      @car.update_column(:mileage, 10)
      garage.toggle!(:open)
    `);
    expect(ds.map((d) => [d.name, d.access])).toEqual([
      ["@match.save!", "write"],
      ["player.save", "write"],
      ["@car.update_column", "write"],
      ["garage.toggle!", "write"],
    ]);
  });

  it("reads a chain whose model constant stands on its own line", () => {
    const ds = dbSources(`
      def goals
        Goal
          .joins(match: { fixtures: :club })
          .where(season: 2026)
      end
    `);
    expect(ds.map((d) => [d.name, d.entity, d.line])).toEqual([["Goal.joins", "Goal", 3]]);
  });
});

describe("rubySpec.extractDataSources — outbound HTTP (api-call)", () => {
  it("captures RestClient verbs in both the paren-less and parenthesised forms", () => {
    const ds = apiCalls(`
      response = RestClient.get url, get_headers(club_external_id)
      response = RestClient.post(url, JSON(new_club), get_headers(external_id))
      RestClient.delete "http://league-api/api/v2/clubs/#{id}"
    `);
    // `name` is the bare verb (the route-linker reads it as the HTTP method);
    // `target` is the URL argument — a literal, or a variable as a runtime hole.
    expect(ds.map((d) => `${d.name} ${d.target}`)).toEqual([
      "get #{url}",
      "post #{url}",
      "delete http://league-api/api/v2/clubs/#{id}",
    ]);
    expect(ds.every((d) => d.kind === "api-call")).toBe(true);
  });

  it("reads the URL past a nested helper call without splitting on its comma", () => {
    // The first arg boundary must respect the parens of get_headers(a, b).
    const ds = apiCalls(`res = RestClient.post(build_url(a, b), payload, get_headers(x, y))`);
    expect(ds).toEqual([expect.objectContaining({ name: "post", target: "#{build_url(a, b)}" })]);
  });

  it("maps Net::HTTP request classes and convenience methods to their verb", () => {
    const ds = apiCalls(`
      request  = Net::HTTP::Post.new(uri.request_uri)
      getreq   = Net::HTTP::Get.new(url)
      response = Net::HTTP.post_form(uri, params)
      response = Net::HTTP.get_response(uri)
    `).map((d) => `${d.name} ${d.target}`);
    expect(ds).toEqual([
      "post #{uri.request_uri}",
      "get #{url}",
      "post #{uri}",
      "get #{uri}",
    ]);
  });

  it("captures other client gems (HTTParty / Faraday / Typhoeus / Excon)", () => {
    const ds = apiCalls(`
      HTTParty.get("https://api.example.com/v1/balls")
      Faraday.delete(endpoint)
      Typhoeus.post(url, body: payload)
      Excon.head(host)
    `).map((d) => d.name);
    expect(ds.sort()).toEqual(["delete", "get", "head", "post"]);
  });

  it("does not false-positive on response types, connection setup, or comments", () => {
    const ds = apiCalls(`
      http = Net::HTTP.new(uri.host, uri.port)      # opens a connection, no verb
      conn = Faraday.new(url)                        # builder, not a request
      ok   = response.is_a?(Net::HTTPSuccess)        # a response type
      # RestClient.get "http://docs" is just a comment
    `);
    expect(ds).toHaveLength(0);
  });

  it("follows requests through a connection object Faraday.new built", () => {
    const ds = apiCalls(`
      class ScoreClient
        def push(body)
          connection.post(endpoint, body)
          uploads.put("https://cdn.example.com/badges")
        end

        def connection
          Faraday.new do |f|
            f.options.timeout = 3
          end
        end

        def uploads
          @uploads ||= Faraday.new do |f|
            f.request :multipart
          end
        end
      end
    `);
    expect(ds.map((d) => `${d.name} ${d.target}`)).toEqual(["post #{endpoint}", "put https://cdn.example.com/badges"]);
  });

  it("leaves a same-named object the file never binds to Faraday alone", () => {
    const ds = apiCalls(`
      def check
        connection.get(key)
      end
      def validate
        conn = Faraday.new(url)
        conn.get("/models")
      end
    `);
    expect(ds.map((d) => `${d.name} ${d.target}`)).toEqual(["get /models"]);
  });

  it("resolves a bare URL variable to its file-local string-literal, keeping #{} verbatim", () => {
    const ds = apiCalls(`
      def self.get_clubs(id)
        url = "#{LEAGUE_API_URL}/clubs"
        response = RestClient.get url, get_headers(id)
      end
    `);
    expect(ds).toEqual([
      expect.objectContaining({ name: "get", target: "#{LEAGUE_API_URL}/clubs" }),
    ]);
  });

  it("keeps the variable as a runtime hole when the assignment is not a string literal — never the path `/url`", () => {
    const ds = apiCalls(`
      url = build_url(a, b)
      RestClient.post(url, payload)
    `);
    expect(ds).toEqual([expect.objectContaining({ name: "post", target: "#{url}" })]);
  });

  it("does not emit api-calls for ActiveRecord model access", () => {
    expect(apiCalls(`players = Player.where(active: true).order(:name)`)).toHaveLength(0);
  });
});

describe("rubySpec.extractDataSources — a local holding a relation", () => {
  it("names the chain the local was assigned, for the association join", () => {
    const ds = dbSources(`
  def fetch_contact
    contact_scope = Current.club.contacts
    contact_scope = contact_scope.includes(contact_inboxes: [:inbox]) if @include_contact_inboxes
    @contact = contact_scope.find(params[:id])
  end
  def names
    items = load_items
    items.first
  end
    `);
    // `items.first` stays out: `items` holds what a method returned, no relation the file can see.
    expect(ds.map((d) => [d.name, d.access])).toEqual([
      ["Current.club.contacts.includes", "read"],
      ["Current.club.contacts.includes.find", "read"],
    ]);
  });
});

describe("rubySpec.extractDataSources — a relation an action hands its view", () => {
  it("reads `@x = Current.club.players` in a controller as that association", () => {
    const lines = `
class Api::PlayersController < ApplicationController
  def index
    @players = Current.club.players
    @name = Current.club.name
    @filters = params.filters
  end
end
class PlayerPresenter
  def rows
    @players = Current.club.players
  end
end`.split("\n");
    const classes = rubySpec.extractClasses!(lines, []);
    const ds = (rubySpec.extractDataSources?.(lines, classes) ?? []).filter((d) => d.kind === "database");
    expect(ds.map((d) => [d.name, d.access, d.line])).toEqual([["Current.club.players.all", "read", 4]]);
  });
});
