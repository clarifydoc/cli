import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { rubyCallChain } from "./di.js";

/** Analyze `files` as one Ruby project and return its summary. */
async function analyzeRuby(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-ruby-finders-"));
  for (const [rel, text] of Object.entries({ Gemfile: 'source "https://rubygems.org"\ngem "rails"\n', ...files })) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), dir };
}

const targetsOf = (summary: ProjectAnalysis, symbol: string, line: number) =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.sourceLine === line && l.relation === "calls").map((l) => `${l.targetFile}::${l.targetSymbol}`);

describe("Ruby call chains off a class", () => {
  it("names each step a call and drops its arguments", () => {
    expect(rubyCallChain("Club.where(active: true).first")).toBe("Club.where().first()");
    expect(rubyCallChain("League::Club.find(id)")).toBe("League::Club.find()");
    expect(rubyCallChain("Club.new(name)")).toBeNull();
    expect(rubyCallChain("club.find(id)")).toBeNull();
  });
});

describe("Ruby ActiveRecord finders return the model", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    ({ summary, dir } = await analyzeRuby({
      "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n",
      "app/models/team.rb": "class Team < ApplicationRecord\n  scope :active, -> { where(active: true) }\n\n  def full_name\n    \"t\"\n  end\n\n  def relegated\n    false\n  end\nend\n",
      // The decoys: another model and a plain class answering the same names.
      "app/models/player.rb": "class Player < ApplicationRecord\n  def full_name\n    \"p\"\n  end\nend\n",
      "app/models/coach.rb": "class Coach\n  def self.find(id)\n    nil\n  end\n\n  def full_name\n    \"c\"\n  end\nend\n",
      "app/services/roster.rb": `class Roster
  def show(id)
    team = Team.find(id)
    team.full_name
    Team.where(active: true).first.full_name
    Team.find_by(name: "x").full_name
    t2 = Team.create!(name: "y")
    t2.full_name
    Team.order(:name).limit(3).last.full_name
    Team.active.first.full_name
    coach = Coach.find(1)
    coach.full_name
    team.relegated?
  end
end
`,
    }));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types a local a finder initializes", () => {
    expect(targetsOf(summary, "Roster.show", 4)).toEqual(["app/models/team.rb::Team.full_name"]);
    expect(targetsOf(summary, "Roster.show", 8)).toEqual(["app/models/team.rb::Team.full_name"]);
  });

  it("types a chain through query methods, finders and scopes", () => {
    expect(targetsOf(summary, "Roster.show", 5)).toEqual(["app/models/team.rb::Team.full_name"]);
    expect(targetsOf(summary, "Roster.show", 6)).toEqual(["app/models/team.rb::Team.full_name"]);
    expect(targetsOf(summary, "Roster.show", 9)).toEqual(["app/models/team.rb::Team.full_name"]);
    expect(targetsOf(summary, "Roster.show", 10)).toContain("app/models/team.rb::Team.full_name");
  });

  it("types nothing through a finder a class declares without a return type, or one off ActiveRecord", () => {
    expect(targetsOf(summary, "Roster.show", 12)).toEqual([]);
  });

  it("keeps a predicate's `?` as part of the name it calls", () => {
    expect(targetsOf(summary, "Roster.show", 13)).toEqual([]);
  });
});
