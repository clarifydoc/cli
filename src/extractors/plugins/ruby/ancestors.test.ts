import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Analyze `files` as one Ruby project and return its summary. */
async function analyzeRuby(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-ruby-ancestors-"));
  for (const [rel, text] of Object.entries({ Gemfile: 'source "https://rubygems.org"\n', ...files })) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), dir };
}

const linksOf = (summary: ProjectAnalysis, symbol: string, callName: string) =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.callName === callName).map((l) => `${l.targetFile}::${l.targetSymbol}`);

describe("Ruby mixins: each keeps how it is mixed in", () => {
  it("records include, extend and prepend in order, and a nested class's include as its own", () => {
    const { classes } = extractWithRegex(
      `module League
  class Club
    include Scoring
    prepend Audit
    extend Standings, Ranking
  end
end
`,
      "app/models/league/club.rb",
      "ruby",
    );
    const league = classes.find((c) => c.name === "League")!;
    const club = classes.find((c) => c.name === "Club")!;
    expect(league.implements).toEqual([]);
    expect(league.mixins).toBeUndefined();
    expect(club.implements).toEqual(["Scoring", "Audit", "Standings", "Ranking"]);
    expect(club.mixins).toEqual([
      { name: "Scoring", kind: "include" },
      { name: "Audit", kind: "prepend" },
      { name: "Standings", kind: "extend" },
      { name: "Ranking", kind: "extend" },
    ]);
  });
});

describe("Ruby mixins: a member is looked up prepends → own → includes → superclass", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    ({ summary, dir } = await analyzeRuby({
      "app/models/concerns/ranking.rb": "module Ranking\n  def tally\n    1\n  end\nend\n",
      "app/models/decoy_ranking.rb": "class DecoyRanking\n  def tally\n    2\n  end\n\n  def table\n    []\n  end\nend\n",
      "app/models/concerns/standings.rb": "module Standings\n  def table\n    []\n  end\nend\n",
      "app/models/concerns/audit.rb": "module Audit\n  def score\n    super + 1\n  end\nend\n",
      "app/models/team.rb": `class Team
  include Ranking
  extend Standings

  def report
    tally
    self.tally
  end

  def lineup
    table
    self.table
  end

  def self.standings
    table
  end

  class << self
    def ranked
      tally
      table
    end
  end
end
`,
      "app/policies/club_policy.rb": `class ClubPolicy
  def scope
    []
  end

  def roster
    []
  end

  class Scope
    attr_reader :scope

    def resolve
      scope
    end

    def members
      roster
    end
  end
end
`,
      "app/services/fixture_dates.rb": `module FixtureDates
  extend Standings

  module_function

  def window
    table
  end
end
`,
      "app/models/club.rb": "class Club\n  prepend Audit\n\n  def score\n    5\n  end\nend\n",
      "app/services/season.rb": `class Season
  def run
    t = Team.new
    t.tally
    Team.new.tally
    Team.table
    Club.new.score
  end
end
`,
    }));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reaches an included module's method on a typed local and on a construction", () => {
    expect(linksOf(summary, "Season.run", "t.tally")).toEqual(["app/models/concerns/ranking.rb::Ranking.tally"]);
    expect(linksOf(summary, "Season.run", "new.tally")).toEqual(["app/models/concerns/ranking.rb::Ranking.tally"]);
  });

  it("reaches it from a bare name and from self inside the class, never the decoy", () => {
    expect(linksOf(summary, "Team.report", "tally")).toEqual(["app/models/concerns/ranking.rb::Ranking.tally"]);
    expect(linksOf(summary, "Team.report", "self.tally")).toEqual(["app/models/concerns/ranking.rb::Ranking.tally"]);
  });

  it("puts an extended module's methods on the class, never on an instance", () => {
    expect(linksOf(summary, "Season.run", "Team.table")).toEqual(["app/models/concerns/standings.rb::Standings.table"]);
    expect(linksOf(summary, "Team.lineup", "table")).toEqual([]);
    expect(linksOf(summary, "Team.lineup", "self.table")).toEqual([]);
  });

  it("reaches an extended module from a method of the class object, never an included one", () => {
    expect(linksOf(summary, "Team.standings", "table")).toEqual(["app/models/concerns/standings.rb::Standings.table"]);
    expect(linksOf(summary, "Team.ranked", "table")).toEqual(["app/models/concerns/standings.rb::Standings.table"]);
    expect(linksOf(summary, "Team.ranked", "tally")).toEqual([]);
    expect(linksOf(summary, "FixtureDates.window", "table")).toEqual(["app/models/concerns/standings.rb::Standings.table"]);
  });

  it("never reaches the enclosing class's methods, nor a reader's namesake, from a nested class", () => {
    expect(linksOf(summary, "Scope.resolve", "scope")).toEqual([]);
    expect(linksOf(summary, "Scope.members", "roster")).toEqual([]);
  });

  it("takes a prepended module's method before the class's own", () => {
    expect(linksOf(summary, "Season.run", "new.score")).toEqual(["app/models/concerns/audit.rb::Audit.score"]);
  });
});
