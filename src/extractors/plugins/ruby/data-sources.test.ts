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
      class AbsencesController < ApplicationController
        def show
          @absence = Absence.find_authorized params[:id], current_institution_id
          @others  = Absence.where(employee_id: @absence.employee_id).order(:date)
          inst     = Institution.find(current_institution_id)
        end
      end
    `);
    const byName = Object.fromEntries(ds.map((d) => [d.name, d]));
    expect(byName["Absence.find_authorized"]).toMatchObject({ kind: "database", entity: "Absence" });
    expect(byName["Absence.where"]).toMatchObject({ entity: "Absence" });
    expect(byName["Institution.find"]).toMatchObject({ entity: "Institution" });
    // The chained `.order(:date)` shares the line but has a lowercase relation
    // receiver — it must NOT produce a second source.
    expect(ds.filter((d) => d.name.endsWith(".order"))).toHaveLength(0);
  });

  it("captures writes (create!/update/destroy) the same way", () => {
    const ds = dbSources(`
      Absence.create!(create_params)
      Duty.update_all(active: false)
      DepartmentEmployee.destroy_all
    `).map((d) => d.name);
    expect(ds).toEqual(
      expect.arrayContaining(["Absence.create!", "Duty.update_all", "DepartmentEmployee.destroy_all"]),
    );
  });

  it("captures raw-SQL finders on a model receiver (find_by_sql / count_by_sql)", () => {
    const ds = dbSources(`
      rows  = Duty.find_by_sql([sql, bindings])
      total = Event.count_by_sql([sql, bindings])
    `);
    const byName = Object.fromEntries(ds.map((d) => [d.name, d]));
    // find_by_sql matches the generic `find_` finder; count_by_sql is explicit.
    expect(byName["Duty.find_by_sql"]).toMatchObject({ entity: "Duty" });
    expect(byName["Event.count_by_sql"]).toMatchObject({ entity: "Event" });
  });

  it("resolves namespaced models to their bare entity name", () => {
    const ds = dbSources(`x = League::MatchReport.where(year: 2026).first`);
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
      rows = Absence.where(active: true)
      Absence.create!(create_params)
      Duty.update_all(active: false)
      one = Institution.find(id)
    `);
    const byName = Object.fromEntries(ds.map((d) => [d.name, d.access]));
    expect(byName["Absence.where"]).toBe("read");
    expect(byName["Institution.find"]).toBe("read");
    expect(byName["Absence.create!"]).toBe("write");
    expect(byName["Duty.update_all"]).toBe("write");
  });

  it("emits an instance/relation chain as an entity-less candidate for the project join", () => {
    // Lowercase / @ivar receivers carry no model name per file: the row goes
    // out without an entity and `RubyEntityExtractor.reconcileProject` joins it
    // to the association's target or the model the variable is named after —
    // or drops it. A read on a bare variable (`absences.each`) is no access.
    const ds = dbSources(`
      @absence.update(params)
      absences.each { |a| a.save }
      self.scope.where(x: 1)
      Current.account.conversations.find_by!(display_id: 3)
    `);
    expect(ds.map((d) => [d.name, d.entity ?? null, d.access])).toEqual([
      ["@absence.update", null, "write"],
      ["self.scope.where", null, "read"],
      ["Current.account.conversations.find_by!", null, "read"],
    ]);
  });

  it("does not match inside comments", () => {
    expect(dbSources(`# Absence.where(foo) is just documentation`)).toHaveLength(0);
  });
});

describe("rubySpec.extractDataSources — outbound HTTP (api-call)", () => {
  it("captures RestClient verbs in both the paren-less and parenthesised forms", () => {
    const ds = apiCalls(`
      response = RestClient.get url, get_headers(institution_external_id)
      response = RestClient.post(url, JSON(new_leaguedata_institution), get_headers(external_id))
      RestClient.delete "http://leaguedata-api/api/v2/institution/#{id}"
    `);
    // `name` is the bare verb (the route-linker reads it as the HTTP method);
    // `target` is the URL argument — a literal, or a variable as a runtime hole.
    expect(ds.map((d) => `${d.name} ${d.target}`)).toEqual([
      "get #{url}",
      "post #{url}",
      "delete http://leaguedata-api/api/v2/institution/#{id}",
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
      HTTParty.get("https://api.example.com/v1/things")
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

  it("resolves a bare URL variable to its file-local string-literal, keeping #{} verbatim", () => {
    const ds = apiCalls(`
      def self.get_institutions(id)
        url = "#{LEAGUEDATA_API_URL}/institution"
        response = RestClient.get url, get_headers(id)
      end
    `);
    expect(ds).toEqual([
      expect.objectContaining({ name: "get", target: "#{LEAGUEDATA_API_URL}/institution" }),
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
    expect(apiCalls(`users = User.where(active: true).order(:name)`)).toHaveLength(0);
  });
});
