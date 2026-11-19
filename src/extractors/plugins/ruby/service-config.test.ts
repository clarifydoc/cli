import { describe, it, expect } from "vitest";
import { rubyServiceConfig, rubyBaseRefOf } from "./service-config.js";

const [yml, rb] = rubyServiceConfig.sources!;

describe("Ruby service configuration", () => {
  it("reads config yml with ERB env fallbacks and marks test sections", () => {
    const entries = yml!.parse(`default: &default
  league_url: <%= ENV.fetch("LEAGUE_URL", "http://league-api:3000") %>
test:
  league_url: http://league-archive:3000
`, "config/services.yml");
    expect(entries.map((e) => [e.key, e.value, e.profile, e.test])).toEqual([
      ["services.league_url", "http://league-api:3000", undefined, undefined],
      ["services.league_url", "http://league-archive:3000", "test", true],
    ]);
    expect(entries[0]!.envNames).toEqual(["LEAGUE_URL"]);
  });

  it("keeps the env name of a variable written without a default", () => {
    const entries = yml!.parse(`default:\n  league_url: <%= ENV.fetch("LEAGUE_URL") %>\n`, "config/services.yml");
    expect(entries).toMatchObject([{ key: "services.league_url", value: "", envNames: ["LEAGUE_URL"] }]);
  });

  it("reads config.x settings per environment", () => {
    const entries = rb!.parse(`config.x.league_url = ENV.fetch("LEAGUE_URL", "http://league-api:3000")\n`, "config/environments/production.rb");
    expect(entries).toMatchObject([{ key: "x.league_url", value: "http://league-api:3000", profile: "production" }]);
  });

  it("reads what a base expression names", () => {
    expect(rubyBaseRefOf(`ENV.fetch("LEAGUE_URL", "http://league-api:3000")`)).toEqual({ kind: "env", key: "LEAGUE_URL", fallback: "http://league-api:3000" });
    expect(rubyBaseRefOf(`ENV['LEAGUE_URL']`)).toEqual({ kind: "env", key: "LEAGUE_URL" });
    expect(rubyBaseRefOf("Rails.configuration.x.league_url")).toEqual({ kind: "config", key: "x.league_url" });
    expect(rubyBaseRefOf(`Rails.application.config_for(:services)[:league_url]`)).toEqual({ kind: "config", key: "services.league_url" });
    expect(rubyBaseRefOf("url")).toBeNull();
  });
});

import { rubySpec } from "./index.js";

describe("Ruby calls state their configured base", () => {
  it("splits a leading ENV or config interpolation off the path", () => {
    const rows = rubySpec.extractDataSources!([
      `HTTParty.get("#{ENV['LEAGUE_URL']}/api/players")`,
      `HTTParty.get("#{Rails.configuration.x.league_url}/api/teams")`,
      `HTTParty.get("#{url}/api/x")`,
    ], []).filter((d) => d.kind === "api-call");
    expect(rows.map((r) => [r.target, r.baseExpr])).toEqual([
      ["/api/players", "ENV['LEAGUE_URL']"],
      ["/api/teams", "Rails.configuration.x.league_url"],
      ["#{url}/api/x", undefined],
    ]);
  });
});
