import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["ruby", "erb"]);
});

describe("Ruby: shapes a macro or a wrapped header leaves", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "app/services/registry.rb": `class Registry
  include Singleton

  def register(name)
    name
  end
end

class LeagueRegistry < Registry
  include Singleton

  def register(name)
    "league-#{name}"
  end
end

class Ledger
  def register(name)
    name
  end
end

class Report
  def run
    Registry.instance.register("x")
    LeagueRegistry.instance.register("y")
  end
end
`,
    "lib/club.rb": `class Club
  def close
    1
  end
end

class Garage
  def close
    2
  end
end

class Academy
  def close
    3
  end
end

Striker = Class.new(Club)

Winger = Class.new(
  Academy
) do
  def cross
    close
  end
end

class Match
  def run
    Striker.new.close
    Winger.new.close
    Garage.new.close
  end
end
`,
    "app/services/score.rb": `Score = Struct.new(:home, :away)
  do
  def total
    home + away
  end
end

Transfer = Struct.new(
  :player,
  :fee
) do
  def describe
    player
  end
end

class Ledger2
  def total
    1
  end

  def describe
    "x"
  end
end

class Lookup
  sig { returns(Score) }
  def score
    Score.new(1, 2)
  end
end

class Tally
  def run
    lk = Lookup.new
    got = lk.score
    got.total
    t = Transfer.new("striker", 1)
    t.describe
  end
end
`,
    "config/routes.rb": `Rails.application.routes.draw do
  get "/clubs/join", to: "clubs#join"
  post "/clubs/join", to: "clubs#join"
  get "/secured/join", to: "secured#join"
  post "/secured/join", to: "secured#join"
end
`,
    "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
    "app/controllers/clubs_controller.rb": "class ClubsController < ApplicationController\n  def join\n  end\nend\n",
    "app/controllers/base_clubs_controller.rb": "class BaseClubsController < ApplicationController\n  def join\n    redirect_to root_path unless current_user\n  end\nend\n",
    "app/controllers/secured_controller.rb": "class SecuredController < BaseClubsController\nend\n",
    "app/views/clubs/join.html.erb": `<%= form_with scope: :club, local: true do |f| %>\n  <button type="submit">Join</button>\n<% end %>\n`,
    "app/views/secured/join.html.erb": `<%= form_with scope: :club, local: true do |f| %>\n  <button type="submit">Join</button>\n<% end %>\n`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-leftovers-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (callName: string, from: string) =>
    summary.symbolLinks.filter((l) => l.callName === callName && l.sourceSymbol === from).map((l) => `${l.targetFile}::${l.targetSymbol}`);

  it("types a call through a singleton's instance as the class it names, never its base", () => {
    expect(target("Registry.instance().register", "Report.run")).toEqual(["app/services/registry.rb::Registry.register"]);
    expect(target("LeagueRegistry.instance().register", "Report.run")).toEqual(["app/services/registry.rb::LeagueRegistry.register"]);
  });

  it("links a call on a constant built by Class.new, with or without a block, and not the namesake", () => {
    expect(target("new.close", "Match.run").sort()).toEqual(["lib/club.rb::Academy.close", "lib/club.rb::Club.close", "lib/club.rb::Garage.close"]);
  });

  it("reads a Struct whose block opens on a later line or after wrapped arguments", () => {
    expect(target("t.describe", "Tally.run")).toEqual(["app/services/score.rb::Transfer.describe"]);
    expect(target("got.total", "Tally.run")).toEqual(["app/services/score.rb::Score.total"]);
  });

  it("types a local assigned once from a reader of a typed local", () => {
    expect(target("got.total", "Tally.run")).toEqual(["app/services/score.rb::Score.total"]);
  });

  it("gives a view the route of its own action only when no inherited action answers the request", () => {
    const rendered = (view: string) => summary.screens?.find((s) => s.filePath === view)?.renderedBy?.map((r) => r.path) ?? [];
    expect(rendered("app/views/clubs/join.html.erb")).toEqual(["/clubs/join"]);
    expect(rendered("app/views/secured/join.html.erb")).toEqual([]);
  });
});
